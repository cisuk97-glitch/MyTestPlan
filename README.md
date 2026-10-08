# SubjectPlan (Supabase & GitHub Pages 버전)

구글 앱스 스크립트(Google Apps Script) 종속성을 완전히 제거하고, **Supabase PostgreSQL DB**와 **GitHub Pages 정적 호스팅**을 결합한 고성능 스마트 스터디 플래너입니다.

---

## 📁 주요 구성 파일

- **`index.html`**: 메인 데일리 플래너 (일정 관리, 스톱워치 학습 타이머, 과목별 D-Day 위젯, 시험 마감 및 리셋).
- **`archive.html`**: 지난 시험 성과 아카이브 및 통계 분석실 (과목별·단원별 공부시간, `score_trend` 회차별 점수 상승 그래프, 최종 지필고사 결과).
- **`add_event.html`**: AI/자연어 간편 일정 등록기 (Gemini Flash API 직접 연동 또는 한국어 규칙 파서 지원).
- **`supabaseClient.js`**: Supabase JS SDK 기반 공통 데이터베이스 연동 레이어.
- **`supabase_planner_addon.sql`**: Supabase 대시보드에 실행할 플래너 전용 DDL 스크립트.

---

## 🚀 1. Supabase 데이터베이스 설정 (최초 1회)

1. [Supabase](https://supabase.com)에 로그인 후 기존 테스트 프로젝트(또는 신규 프로젝트)로 이동합니다.
2. 좌측 메뉴의 **SQL Editor**로 이동합니다.
3. `supabase_planner_addon.sql` 파일의 내용을 복사하여 붙여넣고 **Run**을 실행합니다.
   - `subjects`, `schedules`, `app_settings`, `exam_archives`, `archive_subject_stats`, `archive_lesson_stats` 테이블이 생성됩니다.
   - 기존의 `lessons` 및 `test_records` 테이블과 외래키(`ON DELETE CASCADE`)로 자동 연계됩니다.
4. 좌측 **Project Settings > API**에서 다음 두 가지 값을 확인합니다:
   - **Project URL** (예: `https://xyzcompany.supabase.co`)
   - **anon / public Key** (예: `eyJhbGciOi...`)

---

## ⚡ 2. 플래너에서 Supabase 연동

1. 브라우저에서 `index.html`을 엽니다.
2. 상단 헤더의 **[DB 설정]** 버튼을 클릭합니다.
3. 확인한 **Project URL**과 **Anon Key**를 입력한 후 **[저장 & 동기화]** 를 누릅니다.
4. 이제 단원 등록, 일정 등록, 완료 체크, 타이머 측정 내용이 Supabase와 실시간 자동 동기화됩니다!

---

## 📦 3. 시험 마감 및 아카이브 작동 원리

1. 시험이 끝나면 메인 플래너에서 **[시험 관리 > 시험 마감 및 새 시험 시작]** 을 실행합니다.
2. 과목별 실제 지필고사 성적을 입력하고 마감 버튼을 누릅니다:
   - **1단계**: 과목별/단원별 누적 학습시간, 회차별 성적 추이(`score_trend`), 실제 시험 점수가 아카이브 테이블(`archive_subject_stats`, `archive_lesson_stats`)에 영구 보존됩니다.
   - **2단계**: 다음 시험을 깨끗하게 시작하기 위해 이전 시험의 `schedules`(일정)와 `lessons`(단원)는 자동 삭제(Clean Reset)됩니다.
   - **3단계**: `archive.html`로 이동하면 원본이 삭제된 후에도 과거 시험의 성과 보고서와 점수 그래프를 언제든 100% 온전하게 열람할 수 있습니다.

---

## 🌐 4. GitHub Pages 배포 가이드

1. `app/` 폴더 내의 파일들을 사용자 GitHub 저장소의 `main` 브랜치에 푸시합니다.
2. GitHub 저장소의 **Settings > Pages** 메뉴로 이동합니다.
3. **Build and deployment > Source**: `Deploy from a branch` 선택.
4. **Branch**: `main`, 폴더: `/ (root)` 선택 후 **Save** 클릭.
5. 몇 분 후 제공되는 GitHub Pages URL로 전 세계 어디서든 고속 접속이 가능합니다!
