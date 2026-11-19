# DICOM Tag Editor

**Live Web App:** [https://dcm.tyty.uk/](https://dcm.tyty.uk/)

100% 브라우저 로컬에서 동작하는 **Zero-Build, Zero-Upload** DICOM 태그 편집기 및 메타데이터 뷰어입니다.  
파일을 외부 서버로 전송하지 않고 내 브라우저 메모리 내에서 파싱·편집·검증·비교·익명화·픽셀 프리뷰·무손실 저장을 수행합니다.

> [!CAUTION]
> ### 면책 및 주의사항 (Disclaimer & Legal Notice)
> 1. **비진단용 (Not for Clinical or Diagnostic Use):** 본 소프트웨어는 개발·연구·교육·메타데이터 점검 목적으로만 제공되며, 임상 진단이나 치료를 위한 인증된 의료기기(Medical Device)가 아닙니다.
> 2. **익명화 한계 (De-identification Notice):** 내장된 익명화 기능은 주요 표준 태그 및 Private 태그 정리를 보조할 뿐, **영상 픽셀 자체에 새겨진 텍스트(Burned-in Annotation)**나 비표준/중첩 속성에 포함된 모든 개인식별정보(PHI)의 완전한 제거를 보장하지 않습니다. 개인정보보호법·HIPAA·GDPR 등 관련 법규 준수 여부의 최종 검증 책임은 사용자에게 있습니다.
> 3. **무보증 및 원본 백업 권장 (Provided "AS IS"):** 모든 파일 처리는 사용자의 브라우저 로컬에서만 수행되며 서버로 전송·저장되지 않습니다. 본 소프트웨어는 어떠한 명시적·묵시적 보증 없이 "있는 그대로(AS IS)" 제공되므로, 중요한 DICOM 파일을 편집하거나 덮어쓰기 전에 반드시 **원본 파일을 백업**하시기 바랍니다.

---

## 주요 기능

- **계층형 트리 뷰 (`File Meta 0002` + `Main Dataset` + 중첩 `SQ`)**
  - 실시간 검색(태그 번호, Keyword, VR, 값) 및 퀵 필터(`수정됨`, `오류`, `SQ`, `Private`, `Meta`)
  - 마우스 드래그로 각 컬럼(`Tag`, `Keyword / Name`, `VR`, `VM`, `Len`, `Value`) 넓이 자유 조절
  - 상태별 색상 구분(수정됨 / 추가됨 / 삭제 예정 / VR 오류), 우클릭 컨텍스트 메뉴, 더블클릭/`F2` 인라인 편집
- **우측 Tag Inspector & Raw Hex 디버거**
  - 선택한 태그의 **DICOM PS3.5 VR 표준 스펙**(타입, 최대 길이, 패딩 규칙, VM, 형식 가이드) 및 실시간 유효성 검사
  - 다중값(`VM > 1`) 리스트 편집기, `DA`/`TM` 퀵 입력, `UI` 태그 **새 표준 UID(`2.25.*`) 원클릭 생성**, 비-ASCII 입력 시 `ISO_IR 192` 자동 설정
  - 모든 태그에서 원본 바이트를 확인할 수 있는 **`Raw Bytes (Hex)` 토글**
- **Raw 뷰 (`dcmdump` / DICOM JSON)**
  - DCMTK `dcmdump` 스타일 텍스트 및 구조화 JSON 전체 보기, 클립보드 복사, `.txt` / `.json` 내보내기
- **다중 파일 & 폴더 워크스페이스**
  - 여러 `.dcm` 파일 선택 및 **폴더째 드래그 앤 드롭** 로드 (지연 파싱 및 파일별 독립 Undo/Redo)
  - **두 파일 비교 (`Compare`):** 열린 파일 중 두 개를 선택해 값이 다른 태그를 나란히 비교
  - **일괄 수정 (`Batch Edit`) & 일괄 익명화 (`Anonymize`):** 열린 모든 파일에 특정 태그 일괄 설정/삭제, Private 태그 일괄 제거, Study/Series/SOP UID 일관 재발급
  - **일괄 ZIP 저장 (`Save ZIP`):** 외부 의존성 없이 모든 파일을 표준 `.zip`으로 한 번에 다운로드
- **Pixel 프리뷰 패널 (아코디언 접기/펼치기)**
  - 비압축 Grayscale/RGB, RLE Lossless, JPEG Baseline, 멀티프레임 지원
  - 마우스/터치 드래그 Window/Level 조절, CT W/L 프리셋(`Brain`, `Soft`, `Lung`, `Bone`), 휠 줌 & 패닝, 마우스 커서 `(X, Y)` 좌표 및 픽셀/HU 값 실시간 표시
- **언어 & 테마 & 모바일 최적화**
  - 상단 설정(`⚙`) 다이얼로그에서 **한국어(`KO`) / 영어(`EN`)** 및 **다크 / 라이트 테마** 즉시 전환
  - 모바일 화면 전용 하단 탭바(`파일` / `태그` / `상세` / `Pixel`) 및 2줄 카드형 트리 레이아웃

---

## 로컬 실행 방법

별도의 Node.js 설치나 빌드 과정이 필요 없습니다.

- **Windows:** `run_local.bat` 더블클릭
- **터미널:**
  ```bash
  python -m http.server 8080
  ```
  브라우저에서 `http://localhost:8080` 접속

## GitHub Pages 배포 및 도메인 연결

1. `main` 브랜치에 push하면 `.github/workflows/deploy.yml`이 자동 실행되어 배포됩니다(자동 Cache Busting 포함).
2. GitHub 리포지토리 **Settings → Pages → Build and deployment → Source**를 **GitHub Actions**로 설정합니다.
3. 커스텀 도메인(`dcm.tyty.uk`)은 **Settings → Pages → Custom domain**에 등록하고 DNS `CNAME` 레코드를 `<username>.github.io`로 연결합니다.

## 라이선스 (License)

본 프로젝트는 [MIT License](./LICENSE)에 따라 배포됩니다.
