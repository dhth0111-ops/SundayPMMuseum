# SundayPMMuseum V2.0.3 Stable

가족 문화탐방 기록용 PWA입니다.

## 주요 기능

- 시즌·생활권·장소·맛집 관리
- 방문기록 보기·수정·삭제
- Firestore 데이터 동기화
- 모든 데이터와 모든 사진을 포함한 JSON 전체 백업
- Base64(WebP 우선, JPEG 대체) 사진 백업 및 자동 복원
- PWA 설치 지원

## 백업 방식

앱 전체 ZIP과 `SundayPMMuseum_backup_full_YYYY-MM-DD.json` 파일을 함께 보관하면 됩니다.
사진은 기기 저장소와 전체 JSON 백업에 보관되며, Firestore에는 사진을 제외한 앱 데이터만 동기화됩니다.

## 배포

ZIP을 풀고 안의 파일을 GitHub 저장소 최상단에 업로드합니다.
GitHub Pages는 `main` 브랜치의 `/(root)`를 사용합니다.
- 방문기록 사진 전체화면 크게 보기, 핀치 줌, 좌우 스와이프

## Final Patch

- Firestore 연결 상태와 마지막 동기화 시각을 정확히 표시
- 사진 백업은 JSON(Base64/WebP), 복원은 JSON 자동 복원으로 안내
