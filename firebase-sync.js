import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInAnonymously, GoogleAuthProvider,
  signInWithPopup, signInWithRedirect, signOut
} from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, onSnapshot, serverTimestamp,
  enableIndexedDbPersistence
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

const DOC_TIMEOUT_MS = 30000;
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

function validState(value) {
  return Boolean(value && value.db && Array.isArray(value.db.places));
}

async function saveCloudState(state) {
  if (!currentUser) throw new Error('Firebase 연결 전입니다.');
  if (!validState(state)) throw new Error('앱 데이터 형식이 올바르지 않습니다.');
  await withTimeout(setDoc(userDoc(currentUser.uid), {
    state,
    updatedAt: serverTimestamp(),
    appVersion: 'V2.0.3 Stable',
    photoPolicy: 'Photos are stored locally and included in full JSON backup.'
  }, { merge: true }), '클라우드 저장');
}

async function ensureCloudSeed() {
  if (!currentUser || !hooks) return;
  const snap = await withTimeout(getDoc(userDoc(currentUser.uid)), '클라우드 확인');
  if (!snap.exists()) {
    await saveCloudState(hooks.getState());
    emit('synced', '첫 클라우드 저장 완료');
  }
}

function startListener() {
  if (!currentUser || !hooks) return;
  if (unsubscribe) unsubscribe();
  const uid = currentUser.uid;
  unsubscribe = onSnapshot(userDoc(uid), snap => {
    if (!snap.exists() || uid !== activeUid) return;
    const remote = snap.data()?.state;
    if (!validState(remote)) return;
    applyingRemote = true;
    try {
      hooks.applyRemote(remote, {});
    } finally {
      applyingRemote = false;
    }
    emit('synced', '클라우드 데이터 동기화 완료');
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
    await saveCloudState(state);
    emit('synced', '클라우드 저장 완료');
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
    await saveCloudState(hooks.getState());
    emit('synced', '클라우드 저장 완료');
    return { uploaded: 0, skipped: 0, failed: 0, total: 0 };
  },
  forceDownload: async () => {
    if (!currentUser || !hooks) throw new Error('Firebase 연결 전입니다.');
    const snap = await withTimeout(getDoc(userDoc(currentUser.uid)), '클라우드 불러오기');
    if (!snap.exists()) throw new Error('클라우드 데이터가 없습니다.');
    const remote = snap.data()?.state;
    if (!validState(remote)) throw new Error('클라우드 데이터 형식이 올바르지 않습니다.');
    applyingRemote = true;
    try {
      hooks.applyRemote(remote, {});
    } finally {
      applyingRemote = false;
    }
    emit('synced', '클라우드 데이터를 내려받았습니다.');
  }
};

window.dispatchEvent(new Event('spm-firebase-ready'));
