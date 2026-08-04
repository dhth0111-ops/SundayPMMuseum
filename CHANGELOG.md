# 변경 기록

## V2.0.3 Stable - 2026-08-02

- 방문기록 보기 버튼과 상세보기 유지
- 모든 데이터와 모든 사진을 하나의 JSON에 백업
- WebP 우선, JPEG 대체 방식으로 사진 압축
- 복원 시 사진을 IndexedDB에 다시 저장
- Firebase Storage 업로드 제거
- Firestore에는 사진을 제외한 앱 데이터만 동기화
- 앱 내부 버전 표시를 V2.0.3 Stable로 통일
- README.md 및 VERSION.txt 추가

## V2.0.3 Stable Final
- 방문기록 사진 전체화면 크게 보기
- 핀치 줌 및 더블탭 확대/축소
- 좌우 스와이프 사진 이동
- 전체화면 닫기 및 사진 순서 표시

## V2.0.3 Stable Final Patch - 2026-08-04

- 앱 정보의 Firestore 연결 상태 표시 개선
- 마지막 Firestore 동기화 시각 저장 키 통일 및 정확한 표시
- 사진 백업을 JSON(Base64/WebP), 복원을 JSON 자동 복원으로 안내
- 앱 화면의 사진 클라우드 동기화 문구 제거

## V2.0.3 Stable Restore Fix (2026-08-04)
- Restored the missing `mergeSeedImages()` migration function.
- Fixed JSON backup restore.
- Fixed Firestore cloud download/apply.
- Fixed user initial-data restore.
- Fixed the cloud-download confirmation string and improved error messages.
- Bumped the service-worker cache version.
