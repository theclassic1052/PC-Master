# PC마스터 — Claude 작업 안내

선우컴퓨터(늑대와여우컴퓨터) 3개 사업장(봉일천 본점·일산·광탄)용 통합관리 앱.
일정/AS, 장부(은행 문자 자동 입력), 견적서, 거래명세표, 세금계산서, 고객, 대시보드.
사용자: 상현(단독 사용). 한국어로, 짧고 바로 실행하는 방식으로 대화.

## 바로 작업 시작하는 법 (매번 설정 다시 묻지 말 것)
1. 이 저장소 `theclassic1052/PC-Master` 를 세션에 붙이고(push 권한 있음) `/home/claude/pc-master` 에 shallow clone.
2. 수정 → 아래 "검증" → main 에 커밋·푸시. 그러면 GitHub Pages 가 1~2분 안에 자동 배포.
3. 끝나면 "Ctrl+Shift+R(PC) / 앱 다시 열기(폰)" 안내만 하면 됨. 앱은 화면 복귀 시 새 버전을 자동 새로고침함.

## 저장소 구조
- `index.html` — **빌드된(압축) React 번들 하나**(~480KB, `<script type="module">` 1개). 원본 React 소스는 없음.
  → 수정은 이 파일을 Python 문자열 치환으로 직접 고친다(치환 대상이 정확히 1회 나오는지 assert).
- `sw.js` — 서비스워커(네트워크 우선 캐시). 큰 변경 시 `CACHE` 이름 숫자 올리기.
- `naver.js`, `manifest.json`, 아이콘.
- `android-src.tgz` — 안드로이드 래퍼 앱 소스(WebView 가 `https://theclassic1052.github.io/PC-Master/` 를 띄움 + Bridge.java 로 통화녹음/문자/연락처 네이티브 기능).
  이 파일이 바뀌어 푸시되면 `.github/workflows/apk.yml` 이 APK 를 빌드해 Release `apk` 에 `pcmaster.apk` 로 올림.
  웹 화면만 바꾸면 APK 재설치 불필요.

## 버전 표시
- 번들 안 `var r4="YYYY.MM.DD-NN"` 이 데이터 관리 창 상단 버전. **수정할 때마다 올린다.**
- 앱은 화면 복귀/로드 5초 후 `index.html` 의 r4 를 비교해 다르면 자동 새로고침.

## 번들 안 주요 식별자 (압축 이름)
- `S` 전역 상태(`S.data`, `S.settings`), `Go(patch)` 설정 저장(동기화됨), `ir()` 연동설정 읽기, `Qp()` 연동설정 훅.
- `Rp()` 전체 데이터 내보내기, `Jp(json,"merge"|"replace")` 복원, `wa(blob,name)` 파일 저장, `V(msg)` 토스트, `await E(msg)` 확인창.
- React: `e`/`d` = jsx, `O` = Fragment, `qt`/`At`/`Pt` = React(useState 등).
- `Fe` = 일정 탭 컴포넌트(주간 줄: 오늘을 4번째 가운데, 화살표 하루 단위). `Ev` = 데이터 관리 → 연동 탭.
- `Tv` 동기화 탭(Firebase Firestore 실시간 동기화, `pcm_fbconfig`), `Pv` 백업 탭.

## 연동(데이터 관리 → 연동 탭)
① 볼타 세금계산서(기존 sunwoo-tax-invoice 워커 경유) ② Gmail 재전송(Apps Script) ③ OCR(Claude API)
④ 국세청 보안메일 비밀번호(기기 전용) ⑤ 네이버 메일 IMAP
⑥ GitHub 백업 — 비공개 저장소 `theclassic1052/PAMASTER-DATA` 의 `backup/YYYY-MM-DD.json`, `backup/latest.json` (하루 1회 자동, 데이터 적은 기기는 latest 덮어쓰기 금지)
⑦ 설정 전체 백업 — 연동 키·Firebase 설정 등을 비밀번호로 AES-GCM 암호화해 `backup/settings.enc.json`
서버: `pcmaster-stt.sunwoo-computer.workers.dev`(통화 STT/인입), `sunwoo-tax-invoice.sunwoo-computer.workers.dev`.

## 통화 STT 워커 `pcmaster-stt` (코드는 이 저장소에 없음 — Cloudflare 대시보드에서 직접 관리)
- 구성: `worker.js`(메인) + `naver.js`(IMAP/NTS 메일, 이 저장소 naver.js 와 같은 내용). 바인딩: Workers AI `AI`, KV `SMS`(pcmaster-sms), 변수 `APP_URL`. 비밀: `PCM_KEY`(필수), `GEMINI_API_KEY`·`GROQ_API_KEY`(선택). **키는 반드시 Secret 으로** 넣을 것(Variable 은 평문 노출).
- 경로: `POST /?key&file=` 녹음 업로드(→ 변환 후 인입 주소 반환), `GET /calls`·`/sms`·`/nts`, `GET /engine?key[&set=1|2]` 변환 엔진 조회/저장. 모든 경로는 `key`(=PCM_KEY) 검사.
- 변환 엔진 선택: KV `cfg:stt_engine` = `1`(기존 Workers AI Whisper) / `2`(Gemini 3.5 Transcribe 먼저, 실패 시 Groq→Workers AI). 기본 `2`. 요청에 `&engine=1|2` 를 주면 그 요청만 덮어씀. 앱 통화 인입 창 맨 위 "음성 변환 엔진" 탭이 `/engine` 을 호출.
- 중복 건너뛰기: 파일 SHA-256 해시를 KV `h:<hash>` 에 **변환 전에** 저장(3일). 같은 파일은 "같은 녹음 파일이라 건너뛰었어요"로 끝남. 시험할 땐 `&force=1`(앱의 "녹음 파일 테스트" 버튼이 자동으로 붙임).
- 앱의 통화 인입: 업로드 결과는 KV `call:` 항목으로 쌓이고 앱이 `/calls` 를 폴링해 가져옴. 항목 추출은 앱 안(`a1` 규칙 + 연동 ③ Claude 키가 있으면 `lv/W3` LLM). 금액(`amount`)은 접수 시 AS 건의 `costLabor` 로 전달.
- 수정·배포 요령(대시보드): 편집기의 "Latest" 가 활성 버전과 다를 수 있으니 상단 버전 표시의 `(Active)` 확인. 코드 일부 치환은 편집기 Ctrl+H 로, 배포는 Deploy. 문제 시 Deployments → 이전 버전 `⋯` → Rollback(또는 Promote version). 실시간 로그는 Observability → Live(설정 변경 없이 사용 가능).
- 알려진 제한: Gemini 인라인 업로드는 14MB 초과 시 건너뜀. 어느 엔진이 쓰였는지는 로그(`stt error`)로만 확인됨.

## 검증 (푸시 전 필수)
- 번들 스크립트를 뽑아 `node --check` 로 문법 확인.
- `python3 -m http.server` + Playwright(설치돼 있음)로 화면 열어 pageerror 없는지, 바꾼 부분 스크린샷 확인.

## 주의
- **이 저장소는 공개**다. 토큰·비밀번호·키·계좌번호를 코드나 이 문서에 절대 넣지 말 것. 장부 데이터는 PAMASTER-DATA(비공개)에만.
- 커밋 author 이름: theclassic1052.
