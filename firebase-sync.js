import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInAnonymously, GoogleAuthProvider,
  signInWithPopup, signInWithRedirect, signOut
} from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js';
import {
  getFirestore, doc, collection, getDoc, getDocs, setDoc, deleteDoc,
  onSnapshot, serverTimestamp, enableIndexedDbPersistence
} from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyA-d_6sbQo4DtZ2yW_r3ss2m1irHLxLToU',
  authDomain: 'sundaypmmuseum.firebaseapp.com',
  projectId: 'sundaypmmuseum',
  storageBucket: 'sundaypmmuseum.firebasestorage.app',
  messagingSenderId: '1076918169556',
  appId: '1:1076918169556:web:77ed350a25c8b2ebccb041',
  measurementId: 'G-5MWX6HESPE'
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
enableIndexedDbPersistence(db).catch(() => {});

let currentUser = null;
let unsubscribe = null;
let applyingRemote = false;
let saveTimer = null;
let hooks = null;
let initialized = false;
let activeUid = '';
let saving = false;
let pendingState = null;
let lastPhotoSignature = '';

const DOC_TIMEOUT_MS = 30000;
const PHOTO_TIMEOUT_MS = 120000;
const PHOTO_CHUNK_SIZE = 420000; // Firestore 1MiB 문서 제한보다 충분히 작게 분할

function withTimeout(promise, label, ms = DOC_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 시간이 초과되었습니다.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function emit(status, detail = '') {
  window.dispatchEvent(new CustomEvent('spm-firebase-status', {
    detail: { status, detail, user: currentUser }
  }));
}

function userDoc(uid) {
  return doc(db, 'users', uid, 'apps', 'SundayPMMuseum');
}

function photoCollection(uid) {
  return collection(db, 'users', uid, 'apps', 'SundayPMMuseum', 'photos');
}

function validState(value) {
  return Boolean(value && value.db && Array.isArray(value.db.places));
}

function cleanImages(images) {
  const out = {};
  for (const [key, value] of Object.entries(images || {})) {
    if (typeof value === 'string' && value.startsWith('data:image/')) out[key] = value;
  }
  return out;
}

function photoSignature(images) {
  const entries = Object.entries(cleanImages(images)).sort((a, b) => a[0].localeCompare(b[0]));
  let h = 2166136261 >>> 0;
  for (const [key, value] of entries) {
    const sample = `${key}|${value.length}|${value.slice(0,64)}|${value.slice(-64)}`;
    for (let i = 0; i < sample.length; i++) {
      h ^= sample.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
  }
  return `${entries.length}:${h.toString(16)}`;
}

function keyHash(key) {
  let h1 = 2166136261 >>> 0;
  let h2 = 0x9e3779b9 >>> 0;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 16777619) >>> 0;
    h2 ^= (c + i); h2 = Math.imul(h2, 2246822519) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}

async function saveCloudState(state) {
  if (!currentUser) throw new Error('Firebase 연결 전입니다.');
  if (!validState(state)) throw new Error('앱 데이터 형식이 올바르지 않습니다.');
  await withTimeout(setDoc(userDoc(currentUser.uid), {
    state,
    updatedAt: serverTimestamp(),
    appVersion: 'V2.0.6 Firebase Photo Resume Sync',
    photoPolicy: 'Photos are stored in Firebase Firestore as resumable chunks. Existing identical chunks are skipped after interruption.'
  }, { merge: true }), '클라우드 저장');
}

async function uploadCloudImages(images, force = false) {
  if (!currentUser) throw new Error('Firebase 연결 전입니다.');
  const clean = cleanImages(images);
  const signature = photoSignature(clean);
  if (!force && signature === lastPhotoSignature) {
    return { uploaded: 0, resumed: 0, skippedChunks: 0, writtenChunks: 0, totalChunks: 0, failed: 0, total: Object.keys(clean).length };
  }

  const col = photoCollection(currentUser.uid);
  const existing = await withTimeout(getDocs(col), '클라우드 사진 목록 확인', PHOTO_TIMEOUT_MS);
  const existingById = new Map(existing.docs.map(snap => [snap.id, snap]));
  const desiredIds = new Set();
  let uploaded = 0;
  let resumed = 0;
  let skippedChunks = 0;
  let writtenChunks = 0;
  let totalChunks = 0;
  let processedPhotos = 0;
  const totalPhotos = Object.keys(clean).length;

  // 이어올리기: 이미 같은 조각이 Firestore에 있으면 다시 보내지 않습니다.
  // 업로드가 중간에 끊겨도 다음 실행에서 남은 조각부터 계속됩니다.
  for (const [key, value] of Object.entries(clean)) {
    const total = Math.max(1, Math.ceil(value.length / PHOTO_CHUNK_SIZE));
    totalChunks += total;
    const group = keyHash(key);
    let photoHadExistingChunk = false;
    let photoWroteChunk = false;

    for (let index = 0; index < total; index++) {
      const id = `${group}_${String(index).padStart(4, '0')}`;
      desiredIds.add(id);
      const data = value.slice(index * PHOTO_CHUNK_SIZE, (index + 1) * PHOTO_CHUNK_SIZE);
      const oldSnap = existingById.get(id);
      const old = oldSnap?.data?.() || null;

      if (old && old.key === key && old.index === index && old.total === total && old.data === data) {
        photoHadExistingChunk = true;
        skippedChunks++;
        continue;
      }

      await withTimeout(
        setDoc(doc(col, id), { key, index, total, data, updatedAt: serverTimestamp() }, { merge: false }),
        `사진 이어올리기 (${processedPhotos + 1}/${totalPhotos})`,
        PHOTO_TIMEOUT_MS
      );
      photoWroteChunk = true;
      writtenChunks++;
      emit('uploading', `사진 ${processedPhotos + 1}/${totalPhotos} · 조각 ${writtenChunks + skippedChunks}/${totalChunks} 확인 · 새로 올림 ${writtenChunks} · 건너뜀 ${skippedChunks}`);
    }

    if (photoWroteChunk) uploaded++;
    if (photoHadExistingChunk && photoWroteChunk) resumed++;
    processedPhotos++;
    emit('uploading', `사진 ${processedPhotos}/${totalPhotos} 완료 · 새로 올림 ${writtenChunks}조각 · 이미 올라간 ${skippedChunks}조각 건너뜀`);
  }

  // 모든 현재 사진 업로드가 성공한 뒤에만 오래된 조각을 정리합니다.
  // 중간 실패 시 기존 클라우드 사진을 지우지 않으므로 다음 번에 안전하게 이어집니다.
  for (const snap of existing.docs) {
    if (!desiredIds.has(snap.id)) {
      await withTimeout(deleteDoc(snap.ref), '이전 클라우드 사진 정리', PHOTO_TIMEOUT_MS);
    }
  }

  lastPhotoSignature = signature;
  return { uploaded, resumed, skippedChunks, writtenChunks, totalChunks, failed: 0, total: totalPhotos };
}

async function downloadCloudImages() {
  if (!currentUser) throw new Error('Firebase 연결 전입니다.');
  const snaps = await withTimeout(getDocs(photoCollection(currentUser.uid)), '클라우드 사진 불러오기', PHOTO_TIMEOUT_MS);
  const groups = new Map();

  for (const snap of snaps.docs) {
    const x = snap.data() || {};
    if (typeof x.key !== 'string' || typeof x.data !== 'string' || !Number.isInteger(x.index)) continue;
    if (!groups.has(x.key)) groups.set(x.key, { total: Number(x.total) || 1, chunks: [] });
    groups.get(x.key).chunks[x.index] = x.data;
  }

  const images = {};
  for (const [key, group] of groups.entries()) {
    if (group.chunks.filter(x => typeof x === 'string').length !== group.total) continue;
    const value = group.chunks.join('');
    if (value.startsWith('data:image/')) images[key] = value;
  }
  lastPhotoSignature = photoSignature(images);
  return images;
}

async function saveEverything(state, forcePhotos = false) {
  await saveCloudState(state);
  const images = hooks?.getImages ? hooks.getImages() : {};
  const result = await uploadCloudImages(images, forcePhotos);
  if (result.uploaded > 0 || forcePhotos) {
    await withTimeout(setDoc(userDoc(currentUser.uid), {
      photosUpdatedAt: serverTimestamp(),
      photoCount: result.total
    }, { merge: true }), '사진 동기화 완료 표시');
  }
  return result;
}


async function ensureCloudSeed() {
  if (!currentUser || !hooks) return;
  const snap = await withTimeout(getDoc(userDoc(currentUser.uid)), '클라우드 확인');
  if (!snap.exists()) {
    const result = await saveEverything(hooks.getState(), true);
    emit('synced', `첫 클라우드 저장 완료 · 사진 ${result.total}장`);
    return;
  }
  // V2.0.3에서 V2.0.4로 처음 올릴 때, 클라우드에 사진이 아직 없으면 현재 기기의 사진을 자동 이관합니다.
  const cloudPhotos = await withTimeout(getDocs(photoCollection(currentUser.uid)), '클라우드 사진 확인', PHOTO_TIMEOUT_MS);
  const localImages = hooks.getImages ? cleanImages(hooks.getImages()) : {};
  if (cloudPhotos.empty && Object.keys(localImages).length) {
    const result = await uploadCloudImages(localImages, true);
    await withTimeout(setDoc(userDoc(currentUser.uid), { photosUpdatedAt: serverTimestamp(), photoCount: result.total }, { merge: true }), '사진 이관 완료 표시');
    emit('synced', `기존 사진 클라우드 이관 완료 · 사진 ${result.total}장`);
  }
}

function startListener() {
  if (!currentUser || !hooks) return;
  if (unsubscribe) unsubscribe();
  const uid = currentUser.uid;
  unsubscribe = onSnapshot(userDoc(uid), async snap => {
    if (!snap.exists() || uid !== activeUid) return;
    const remote = snap.data()?.state;
    if (!validState(remote)) return;
    try {
      const cloudImages = await downloadCloudImages();
      if (uid !== activeUid) return;
      applyingRemote = true;
      try {
        hooks.applyRemote(remote, cloudImages);
      } finally {
        applyingRemote = false;
      }
      emit('synced', `클라우드 데이터·사진 동기화 완료 · 사진 ${Object.keys(cloudImages).length}장`);
    } catch (error) {
      emit('error', `사진 동기화 실패: ${error.message}`);
    }
  }, err => emit('error', err.message));
}

async function connect() {
  if (!auth.currentUser) await signInAnonymously(auth);
}

async function loginGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await signInWithPopup(auth, provider);
  } catch (error) {
    if (['auth/popup-blocked', 'auth/cancelled-popup-request', 'auth/operation-not-supported-in-this-environment'].includes(error.code)) {
      await signInWithRedirect(auth, provider);
      return;
    }
    throw error;
  }
}

async function logout() {
  await signOut(auth);
  await signInAnonymously(auth);
}

async function performSave(state) {
  if (!currentUser || !validState(state)) return;
  if (saving) {
    pendingState = state;
    return;
  }
  saving = true;
  try {
    const result = await saveEverything(state, false);
    emit('synced', result.uploaded ? `클라우드 저장 완료 · 사진 ${result.total}장 · 이어올리기 ${result.resumed}장` : `클라우드 저장 완료 · 사진 ${result.total}장 확인`);
  } catch (error) {
    emit('error', error.message);
  } finally {
    saving = false;
    if (pendingState) {
      const next = pendingState;
      pendingState = null;
      performSave(next);
    }
  }
}

function queueSave(state) {
  if (applyingRemote || !currentUser || !validState(state)) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => performSave(state), 1200);
}

window.FirebaseSync = {
  init(nextHooks) {
    if (initialized) return;
    initialized = true;
    hooks = nextHooks;
    emit('connecting', 'Firebase 연결 중');
    onAuthStateChanged(auth, async user => {
      currentUser = user;
      activeUid = user?.uid || '';
      lastPhotoSignature = '';
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (!user) return;
      emit('connected', user.isAnonymous ? '익명 계정 연결됨' : `${user.email || 'Google 계정'} 연결됨`);
      try {
        await ensureCloudSeed();
        startListener();
      } catch (error) {
        emit('error', error.message);
      }
    });
    connect().catch(error => emit('error', error.message));
  },
  queueSave,
  loginGoogle,
  logout,
  getUser: () => currentUser,
  forceUpload: async () => {
    if (!currentUser || !hooks) throw new Error('Firebase 연결 전입니다.');
    const result = await saveEverything(hooks.getState(), true);
    emit('synced', `Firebase 데이터·사진 저장 완료 · 사진 ${result.total}장 · 새로 올림 ${result.writtenChunks}조각 · 건너뜀 ${result.skippedChunks}조각`);
    return result;
  },
  forceDownload: async () => {
    if (!currentUser || !hooks) throw new Error('Firebase 연결 전입니다.');
    const snap = await withTimeout(getDoc(userDoc(currentUser.uid)), '클라우드 불러오기');
    if (!snap.exists()) throw new Error('클라우드 데이터가 없습니다.');
    const remote = snap.data()?.state;
    if (!validState(remote)) throw new Error('클라우드 데이터 형식이 올바르지 않습니다.');
    const cloudImages = await downloadCloudImages();
    applyingRemote = true;
    try {
      hooks.applyRemote(remote, cloudImages);
    } finally {
      applyingRemote = false;
    }
    emit('synced', `클라우드 데이터·사진을 내려받았습니다. · 사진 ${Object.keys(cloudImages).length}장`);
    return { total: Object.keys(cloudImages).length };
  }
};

window.dispatchEvent(new Event('spm-firebase-ready'));
