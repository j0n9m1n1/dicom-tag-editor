# DICOM Tag Editor

100% 브라우저 로컬에서 동작하는 **Zero-Build, Zero-Upload** DICOM 태그 편집기입니다.  
파일을 외부 서버로 전송하지 않고 브라우저 메모리 내에서 파싱·편집·검증·픽셀 프리뷰·무손실 저장을 수행합니다.

## 주요 기능

- **계층형 트리 뷰 (`File Meta 0002` + `Main Dataset` + 중첩 `SQ`)**
  - 실시간 검색(태그 번호, Keyword, VR, 값) 및 퀵 필터(`수정됨`, `오류`, `SQ`, `Private`, `Meta`)
  - 상태별 색상 구분(수정됨 / 추가됨 / 삭제 예정 / VR 오류) 및 VR 카테고리 배지
  - 더블클릭/`F2` 인라인 편집, 방향키/Delete 키보드 네비게이션
- **우측 Tag Inspector**
  - 선택한 태그의 **DICOM PS3.5 VR 표준 스펙**(타입, 최대 길이, 패딩 규칙, VM, 형식 가이드) 표시
  - 실시간 VR 유효성 검사 및 바이트 길이 카운터
  - 다중값(`VM > 1`) 리스트 편집기, `DA`/`TM` 퀵 입력, 한글 등 비-ASCII 입력 시 `ISO_IR 192` 자동 설정 지원
  - 바이너리 태그(`OB`/`OW`/`UN`/`PixelData`) Hex 덤프 프리뷰
- **원본 바이트 보존형(Round-trip Safe) 저장**
  - 수정하지 않은 태그 및 `PixelData`(압축 포함) 원본 바이트 무손실 유지
  - `0002,0000` (FileMetaInformationGroupLength) 및 `SQ` 길이 자동 재계산
  - Chrome/Edge에서는 File System Access API로 **원본 파일 직접 덮어쓰기** 또는 **다른 이름으로 저장** 지원
- **편의 기능**
  - `Undo / Redo` (`Ctrl+Z` / `Ctrl+Y`)
  - 저장 전 **변경 내역(Diff)** 확인 및 개별 되돌리기
  - **익명화(Anonymize)** 프리셋 (`PatientIdentityRemoved=YES` 자동 기록)
  - **Pixel 프리뷰 패널** (비압축 Grayscale/RGB, RLE Lossless, JPEG Baseline, 멀티프레임, 드래그 Window/Level 조절, Invert)
  - 다크 / 라이트 테마 전환 & 내장 샘플 CT DICOM 생성기

## 로컬 실행 방법

별도의 Node.js 설치나 빌드가 필요 없습니다.

- **Windows:** `run_local.bat` 더블클릭
- **터미널:**
  ```bash
  python -m http.server 8080
  ```
  브라우저에서 `http://localhost:8080` 열기

## GitHub Pages 배포 및 도메인 연결

1. 이 리포지토리를 GitHub `main` 브랜치에 푸시합니다.
2. GitHub 리포지토리 **Settings → Pages → Build and deployment → Source**를 **GitHub Actions**로 선택합니다.
3. 커스텀 도메인을 연결하려면 **Settings → Pages → Custom domain**에 도메인(예: `dicom.yourdomain.com`)을 입력하고, DNS에 CNAME 레코드(`<username>.github.io`)를 추가합니다. (원할 경우 리포지토리 루트에 도메인이 적힌 `CNAME` 파일을 두어도 자동 반영됩니다.)

## 향후 확장 (압축 픽셀 코덱)

`src/dicom/pixelRenderer.js`가 독립 모듈로 분리되어 있어, 추후 JPEG2000 / JPEG-LS / HTJ2K 같은 고압축 영상 프리뷰가 필요할 때 해당 모듈에만 WASM 디코더를 연결하여 확장할 수 있습니다.
