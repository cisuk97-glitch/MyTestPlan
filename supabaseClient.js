/**
 * app/supabaseClient.js
 * SubjectPlan Supabase Client Layer
 * - 공유 테이블: lessons, test_records
 * - 플래너 전용 테이블: subjects, schedules, app_settings, exam_archives, archive_subject_stats, archive_lesson_stats
 */

(function (window) {
  'use strict';

  const STORAGE_URL_KEY = 'SP_SUPABASE_URL';
  const STORAGE_ANON_KEY = 'SP_SUPABASE_ANON_KEY';

  let _client = null;

  const SupabaseService = {
    // ----------------------------------------------------
    // 1. 설정 및 클라이언트 초기화
    // ----------------------------------------------------
    getConfig() {
      const url = localStorage.getItem(STORAGE_URL_KEY) || (window.SUPABASE_DEFAULT_CONFIG && window.SUPABASE_DEFAULT_CONFIG.url) || '';
      const anonKey = localStorage.getItem(STORAGE_ANON_KEY) || (window.SUPABASE_DEFAULT_CONFIG && window.SUPABASE_DEFAULT_CONFIG.anonKey) || '';
      return { url: url.trim(), anonKey: anonKey.trim() };
    },

    saveConfig(url, anonKey) {
      if (url) localStorage.setItem(STORAGE_URL_KEY, url.trim());
      else localStorage.removeItem(STORAGE_URL_KEY);

      if (anonKey) localStorage.setItem(STORAGE_ANON_KEY, anonKey.trim());
      else localStorage.removeItem(STORAGE_ANON_KEY);

      _client = null; // Re-initialize on next getClient
      return this.getClient() !== null;
    },

    isConfigured() {
      const conf = this.getConfig();
      return Boolean(conf.url && conf.anonKey);
    },

    getClient() {
      if (_client) return _client;
      const { url, anonKey } = this.getConfig();
      if (!url || !anonKey) return null;

      if (typeof window.supabase === 'undefined' || typeof window.supabase.createClient !== 'function') {
        console.error('Supabase JS SDK가 로드되지 않았습니다.');
        return null;
      }

      try {
        _client = window.supabase.createClient(url, anonKey, {
          auth: { persistSession: false }
        });
        return _client;
      } catch (e) {
        console.error('Supabase 클라이언트 생성 실패:', e);
        return null;
      }
    },

    async testConnection() {
      const client = this.getClient();
      if (!client) throw new Error('Supabase URL 및 Anon Key가 설정되지 않았습니다.');
      
      const errors = [];
      const { error: lessonErr } = await client.from('lessons').select('id').limit(1);
      if (lessonErr) errors.push(`[lessons 테이블] ${lessonErr.message} (코드: ${lessonErr.code || ''})`);

      const { error: subjErr } = await client.from('subjects').select('name').limit(1);
      if (subjErr) errors.push(`[subjects 테이블] ${subjErr.message} (코드: ${subjErr.code || ''})`);

      const { error: schedErr } = await client.from('schedules').select('id').limit(1);
      if (schedErr) errors.push(`[schedules 테이블] ${schedErr.message} (코드: ${schedErr.code || ''})`);

      if (errors.length > 0) {
        throw new Error('테이블 접근 실패:\n' + errors.join('\n'));
      }
      return true;
    },

    // ----------------------------------------------------
    // 2. 전체 플래너 상태 로드 (subjects, lessons, test_records, schedules, app_settings)
    // ----------------------------------------------------
    async loadPlannerState() {
      const client = this.getClient();
      if (!client) return null;

      try {
        // 병렬 조회
        const [subjRes, lessonRes, testRes, schedRes, settingRes] = await Promise.all([
          client.from('subjects').select('*').order('name'),
          client.from('lessons').select('*').order('id'),
          client.from('test_records').select('*').order('round', { ascending: true }).order('test_date', { ascending: true }),
          client.from('schedules').select('*').order('date', { ascending: true }),
          client.from('app_settings').select('*')
        ]);

        const queryErrors = [];
        if (subjRes.error) queryErrors.push(`[subjects 테이블] ${subjRes.error.message} (코드: ${subjRes.error.code || ''})`);
        if (schedRes.error) queryErrors.push(`[schedules 테이블] ${schedRes.error.message} (코드: ${schedRes.error.code || ''})`);
        if (lessonRes.error) queryErrors.push(`[lessons 테이블] ${lessonRes.error.message} (코드: ${lessonRes.error.code || ''})`);
        if (testRes.error) queryErrors.push(`[test_records 테이블] ${testRes.error.message} (코드: ${testRes.error.code || ''})`);

        if (queryErrors.length > 0) {
          const errMsg = 'Supabase 테이블 조회 실패:\n' + queryErrors.join('\n');
          console.error(errMsg, { subjRes, schedRes, lessonRes, testRes });
          throw new Error(errMsg);
        }

        const rawSubjects = subjRes.data || [];
        const rawLessons = lessonRes.data || [];
        const rawTests = testRes.data || [];
        const rawSchedules = schedRes.data || [];
        const rawSettings = settingRes.data || [];

        console.log(`[Supabase 로드 성공] 과목: ${rawSubjects.length}건, 일정: ${rawSchedules.length}건, 단원: ${rawLessons.length}건, 성적: ${rawTests.length}건`);

        // 1. 단원별 test_records 매핑 (성적 추이 & 최신 점수)
        const testsByLessonId = {};
        rawTests.forEach(t => {
          if (!testsByLessonId[t.lesson_id]) testsByLessonId[t.lesson_id] = [];
          testsByLessonId[t.lesson_id].push(t);
        });

        const lessonsBySubject = {};
        rawLessons.forEach(l => {
          const lTests = testsByLessonId[l.id] || [];
          const scores = lTests.map(t => Number(t.score)).filter(s => !isNaN(s));
          const avgScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
          const latestTest = lTests.length > 0 ? lTests[lTests.length - 1] : null;

          const lessonObj = {
            id: l.id,
            subjectName: l.subject_name,
            unitName: l.unit_name,
            createdAt: l.created_at,
            tests: lTests,
            avgScore: avgScore,
            latestScore: latestTest ? latestTest.score : null,
            latestStars: latestTest ? latestTest.stars_won : 0,
            testCount: lTests.length,
            // 호환용 속성
            isCompleted: lTests.length > 0
          };

          if (!lessonsBySubject[l.subject_name]) lessonsBySubject[l.subject_name] = [];
          lessonsBySubject[l.subject_name].push(lessonObj);
        });

        // 2. 과목 구조화 (lessons 테이블 데이터를 바탕으로 chapters 매핑 및 보존)
        const subjects = rawSubjects.map(s => {
          let chapters = [];
          if (Array.isArray(s.chapters)) {
            chapters = s.chapters;
          } else if (typeof s.chapters === 'string') {
            try { chapters = JSON.parse(s.chapters); } catch (e) { chapters = []; }
          }

          // 소단원 중첩 구조가 남아있는 경우 대단원 단일 구조로 정규화
          chapters = chapters.map(ch => {
            if (ch.subunits && Array.isArray(ch.subunits) && ch.subunits.length > 0) {
              const firstScored = ch.subunits.find(su => su.unitScore !== '' && su.unitScore !== undefined);
              const scoreHist = [];
              ch.subunits.forEach(su => {
                if (Array.isArray(su.scoreHistory)) scoreHist.push(...su.scoreHistory);
              });
              return {
                id: ch.id || ('ch-' + Date.now()),
                title: ch.title || '',
                inScope: ch.inScope !== false,
                unitScore: ch.unitScore !== undefined ? ch.unitScore : (firstScored ? firstScored.unitScore : ''),
                scoreHistory: Array.isArray(ch.scoreHistory) && ch.scoreHistory.length > 0 ? ch.scoreHistory : scoreHist
              };
            }
            return {
              id: ch.id || ('ch-' + Date.now()),
              title: ch.title || '',
              inScope: ch.inScope !== false,
              unitScore: ch.unitScore !== undefined ? ch.unitScore : '',
              scoreHistory: Array.isArray(ch.scoreHistory) ? ch.scoreHistory : []
            };
          });

          // lessons 테이블에 등록된 단원이 있는 경우, lessons를 Source of Truth로 하여 chapters 구성
          const sLessons = lessonsBySubject[s.name] || [];
          if (sLessons.length > 0) {
            chapters = sLessons.map(l => {
              const matched = chapters.find(c => String(c.id) === String(l.id) || c.title === l.unitName);
              const hist = Array.isArray(l.tests) ? l.tests.map(t => Number(t.score)).filter(n => !isNaN(n)) : [];
              return {
                id: String(l.id),
                title: l.unitName,
                inScope: matched ? matched.inScope !== false : true,
                unitScore: l.latestScore !== null && l.latestScore !== undefined ? l.latestScore : (matched ? matched.unitScore : ''),
                scoreHistory: hist.length > 0 ? hist : (matched && matched.scoreHistory ? matched.scoreHistory : [])
              };
            });
          }

          let mockTests = [];
          if (Array.isArray(s.mock_tests)) {
            mockTests = s.mock_tests;
          } else if (typeof s.mock_tests === 'string') {
            try { mockTests = JSON.parse(s.mock_tests); } catch (e) { mockTests = []; }
          }
          return {
            id: 'subj-' + encodeURIComponent(s.name),
            name: s.name,
            dday: s.dday || '',
            targetScore: s.target_score !== undefined ? s.target_score : 100,
            color: s.color || 'indigo',
            academyName: s.academy_name || '',
            chapters: chapters,
            mockTests: mockTests,
            lessons: sLessons
          };
        });

        // 3. lessons에 등록된 과목명이 subjects에 없으면 자동 합성
        Object.keys(lessonsBySubject).forEach(sName => {
          if (!subjects.find(s => s.name === sName)) {
            const sLessons = lessonsBySubject[sName] || [];
            const synChapters = sLessons.map(l => {
              const hist = Array.isArray(l.tests) ? l.tests.map(t => Number(t.score)).filter(n => !isNaN(n)) : [];
              return {
                id: String(l.id),
                title: l.unitName,
                inScope: true,
                unitScore: l.latestScore !== null && l.latestScore !== undefined ? l.latestScore : '',
                scoreHistory: hist
              };
            });
            subjects.push({
              id: 'subj-' + encodeURIComponent(sName),
              name: sName,
              dday: '',
              targetScore: 100,
              color: 'emerald',
              academyName: '',
              chapters: synChapters,
              mockTests: [],
              lessons: sLessons
            });
          }
        });

        // 4. 스케줄 정규화
        const schedules = rawSchedules.map(sch => {
          let startTime = '';
          if (sch.detail) {
            const timeMatch = sch.detail.match(/(\d{1,2}:\d{2})/);
            if (timeMatch) startTime = timeMatch[1];
          }
          return {
            id: sch.id,
            lessonId: sch.lesson_id,
            subject: sch.subject,
            date: String(sch.date || '').trim(),
            category: sch.category || '진도계획',
            title: sch.title,
            detail: sch.detail || '',
            startTime: startTime,
            progress: Number(sch.progress) || 0,
            score: sch.score ? String(sch.score) : '',
            durationSec: Number(sch.duration_sec) || 0,
            completed: Boolean(sch.completed),
            subunitIds: sch.subunit_ids || [],
            completedSubunits: sch.completed_subunits || []
          };
        });

        // 5. 전역 설정 파싱
        const settingsMap = {};
        rawSettings.forEach(st => {
          settingsMap[st.key] = st.value;
        });

        return {
          subjects,
          schedules,
          appTitle: settingsMap.appTitle || '스마트 스터디 플래너',
          academyNames: settingsMap.academyNames || {}
        };
      } catch (err) {
        console.error('loadPlannerState 오류:', err);
        throw err;
      }
    },

    // ----------------------------------------------------
    // 3. 단원 (lessons) CRUD
    // ----------------------------------------------------
    async addLesson(subjectName, unitName) {
      const client = this.getClient();
      if (!client) throw new Error('Supabase 미연결');
      const { data, error } = await client
        .from('lessons')
        .insert([{ subject_name: subjectName.trim(), unit_name: unitName.trim() }])
        .select()
        .single();
      if (error) throw error;
      return data;
    },

    async deleteLesson(lessonId) {
      const client = this.getClient();
      if (!client) throw new Error('Supabase 미연결');
      // ON DELETE CASCADE로 test_records 자동 삭제됨
      const { error } = await client.from('lessons').delete().eq('id', lessonId);
      if (error) throw error;
      return true;
    },

    async updateLesson(lessonId, unitName) {
      const client = this.getClient();
      if (!client) throw new Error('Supabase 미연결');
      const { data, error } = await client
        .from('lessons')
        .update({ unit_name: unitName.trim() })
        .eq('id', lessonId)
        .select()
        .single();
      if (error) throw error;
      return data;
    },

    async bulkAddLessons(subjectName, unitNames) {
      const client = this.getClient();
      if (!client) throw new Error('Supabase 미연결');
      const rows = unitNames.map(u => ({
        subject_name: subjectName.trim(),
        unit_name: u.trim()
      })).filter(r => r.unit_name.length > 0);
      if (rows.length === 0) return [];
      const { data, error } = await client
        .from('lessons')
        .insert(rows)
        .select();
      if (error) throw error;
      return data;
    },

    // ----------------------------------------------------
    // 4. 성적 (test_records) 추가
    // ----------------------------------------------------
    async addTestRecord(record) {
      const client = this.getClient();
      if (!client) throw new Error('Supabase 미연결');
      const payload = {
        lesson_id: record.lessonId,
        test_category: record.testCategory || 'VOCAB',
        test_title: record.testTitle || '',
        round: record.round || 1,
        test_mode: record.testMode || 'ALL',
        score: Math.round(Number(record.score) || 0),
        correct_count: Number(record.correctCount) || 0,
        total_count: Number(record.totalCount) || 0,
        stars_won: Number(record.starsWon) || 0,
        duration_seconds: Number(record.durationSeconds) || 0,
        test_date: record.testDate || new Date().toISOString()
      };
      const { data, error } = await client.from('test_records').insert([payload]).select().single();
      if (error) throw error;
      return data;
    },

    // ----------------------------------------------------
    // 5. 과목 (subjects) 저장 / 갱신
    // ----------------------------------------------------
    async saveSubjects(subjectsList) {
      const client = this.getClient();
      if (!client) return false;
      if (!Array.isArray(subjectsList) || subjectsList.length === 0) return true;

      const rows = subjectsList.map(s => ({
        name: s.name,
        dday: s.dday || '',
        target_score: s.targetScore || 100,
        color: s.color || 'indigo',
        academy_name: s.academyName || '',
        chapters: s.chapters || [],
        mock_tests: s.mockTests || [],
        updated_at: new Date().toISOString()
      }));

      const { error } = await client.from('subjects').upsert(rows, { onConflict: 'name' });
      if (error) console.error('subjects 저장 오류:', error);
      return !error;
    },

    // ----------------------------------------------------
    // 6. 스케줄 (schedules) 저장 / 갱신 / 삭제
    // ----------------------------------------------------
    async saveSchedules(schedulesList) {
      const client = this.getClient();
      if (!client) return false;

      // Clean upsert
      const rows = schedulesList.map(sch => ({
        id: sch.id,
        lesson_id: sch.lessonId || null,
        subject: sch.subject,
        date: sch.date,
        category: sch.category || '진도계획',
        title: sch.title,
        detail: sch.detail || '',
        progress: sch.progress || 0,
        score: sch.score ? String(sch.score) : '',
        duration_sec: sch.durationSec || 0,
        completed: Boolean(sch.completed),
        updated_at: new Date().toISOString()
      }));

      if (rows.length === 0) return true;

      const { error } = await client.from('schedules').upsert(rows, { onConflict: 'id' });
      if (error) console.error('schedules 저장 오류:', error);
      return !error;
    },

    async deleteSchedule(scheduleId) {
      const client = this.getClient();
      if (!client) return false;
      const { error } = await client.from('schedules').delete().eq('id', scheduleId);
      return !error;
    },

    async insertSchedules(events) {
      const client = this.getClient();
      if (!client) throw new Error('Supabase 미연결');
      if (!Array.isArray(events) || events.length === 0) return true;

      const rows = events.map(e => ({
        id: e.id || ('sch_' + Math.random().toString(36).substr(2, 9)),
        lesson_id: e.lessonId || null,
        subject: e.subject || '공통',
        date: e.date,
        category: e.category || '진도계획',
        title: e.title,
        detail: e.detail || '',
        progress: e.progress || 0,
        score: e.score ? String(e.score) : '',
        duration_sec: e.durationSec || 0,
        completed: Boolean(e.completed),
        updated_at: new Date().toISOString()
      }));

      const { error } = await client.from('schedules').insert(rows);
      if (error) throw error;
      return true;
    },

    // ----------------------------------------------------
    // 7. 전역 설정 (app_settings) 저장
    // ----------------------------------------------------
    async saveSetting(key, value) {
      const client = this.getClient();
      if (!client) return false;
      const { error } = await client.from('app_settings').upsert({
        key,
        value,
        updated_at: new Date().toISOString()
      }, { onConflict: 'key' });
      return !error;
    },

    // ----------------------------------------------------
    // 8. 시험 마감 및 아카이브 저장 & 클린 리셋 (archiveAndResetExam)
    // ----------------------------------------------------
    async archiveAndResetExam(archivePayload) {
      const client = this.getClient();
      if (!client) throw new Error('Supabase 미연결 상태입니다.');

      const examId = 'exam_' + Date.now();
      const curExam = archivePayload.curExam || {};
      const nextExam = archivePayload.nextExam || {};
      const summary = archivePayload.summary || {};
      const actualScores = curExam.actualScores || {}; // { '영어': 95, '국어': 92, 'subj-...': 95 }

      // 1. 과목 데이터 확보 (payload 루트 -> payload.summary.subjects -> DB subjects 직접 조회 Fallback)
      let archiveSubjects = archivePayload.subjects || archivePayload.summary?.subjects || [];
      if (!Array.isArray(archiveSubjects) || archiveSubjects.length === 0) {
        try {
          const { data: dbSubjects } = await client.from('subjects').select('*');
          if (dbSubjects && dbSubjects.length > 0) {
            archiveSubjects = dbSubjects.map(s => ({
              id: 'subj-' + encodeURIComponent(s.name),
              name: s.name,
              targetScore: s.target_score || 100,
              chapters: Array.isArray(s.chapters) ? s.chapters : []
            }));
          }
        } catch (dbSubErr) {
          console.warn('DB subjects 직접 조회 폴백 오류:', dbSubErr);
        }
      }

      // (1) 카테고리별 시간 집계
      const categoryTimes = {};
      let totalDurationSec = 0;
      (archivePayload.curSchedules || []).forEach(s => {
        const sec = Number(s.durationSec) || (Number(s.duration_sec) || 0);
        const cat = s.category || '진도계획';
        categoryTimes[cat] = (categoryTimes[cat] || 0) + sec;
        totalDurationSec += sec;
      });

      // (2) 과목별 통계 산출
      const subjectStatsRows = [];
      archiveSubjects.forEach(subj => {
        let sTotalSec = 0;
        let sAcadSec = 0;
        let sSelfSec = 0;

        (archivePayload.curSchedules || []).filter(sch => sch.subject === subj.name).forEach(sch => {
          const sec = Number(sch.durationSec) || (Number(sch.duration_sec) || 0);
          sTotalSec += sec;
          if (sch.category === '학원일정' || (sch.category && sch.category.includes('학원'))) {
            sAcadSec += sec;
          } else {
            sSelfSec += sec;
          }
        });

        const finalScore = actualScores[subj.name] !== undefined && actualScores[subj.name] !== '' 
          ? Number(actualScores[subj.name]) 
          : (subj.id && actualScores[subj.id] !== undefined && actualScores[subj.id] !== ''
              ? Number(actualScores[subj.id])
              : (subj.actualScore !== undefined && subj.actualScore !== '' ? Number(subj.actualScore) : null));

        subjectStatsRows.push({
          exam_id: examId,
          subject_name: subj.name,
          target_score: subj.targetScore || 100,
          final_score: finalScore,
          total_duration_sec: sTotalSec,
          acad_duration_sec: sAcadSec,
          self_duration_sec: sSelfSec
        });
      });

      // (3) 대단원별 통계 및 회차별 점수 추이 (score_trend) 산출
      // subjects의 chapters를 기준으로 archive_lesson_stats 구성 (대단원 단일화 반영)
      const lessonStatsRows = [];
      const handledUnits = new Set();

      archiveSubjects.forEach(subj => {
        const chapters = subj.chapters || [];
        chapters.forEach(ch => {
          let chSec = 0;
          (archivePayload.curSchedules || []).filter(sch => 
            sch.subject === subj.name && (sch.title?.includes(ch.title) || sch.chapterTitle === ch.title || sch.chapterId === ch.id)
          ).forEach(sch => {
            chSec += Number(sch.durationSec) || 0;
          });

          const scores = Array.isArray(ch.scoreHistory) ? ch.scoreHistory.map(Number).filter(n => !isNaN(n)) : [];
          if (ch.unitScore !== '' && ch.unitScore !== null && ch.unitScore !== undefined && !isNaN(Number(ch.unitScore)) && scores.length === 0) {
            scores.push(Number(ch.unitScore));
          }

          const avgScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
          const scoreTrend = scores.map((sc, idx) => ({
            round: idx + 1,
            score: sc,
            category: '단원테스트'
          }));

          lessonStatsRows.push({
            exam_id: examId,
            subject_name: subj.name,
            unit_name: ch.title,
            study_duration_sec: chSec,
            avg_score: avgScore,
            score_trend: scoreTrend,
            category_scores: { '단원테스트': avgScore },
            test_count: scores.length
          });
          handledUnits.add(`${subj.name}::${ch.title}`);
        });
      });

      // lessons 테이블에 독립 단원이 남아있는 경우 보존
      const { data: currentLessons } = await client.from('lessons').select('*');
      if (currentLessons && currentLessons.length > 0) {
        const { data: allTestRecords } = await client.from('test_records').select('*').order('round', { ascending: true });
        const testsByLessonId = {};
        (allTestRecords || []).forEach(t => {
          if (!testsByLessonId[t.lesson_id]) testsByLessonId[t.lesson_id] = [];
          testsByLessonId[t.lesson_id].push(t);
        });

        currentLessons.forEach(l => {
          if (handledUnits.has(`${l.subject_name}::${l.unit_name}`)) return;
          let lSec = 0;
          (archivePayload.curSchedules || []).filter(sch => sch.lessonId === l.id).forEach(sch => {
            lSec += Number(sch.durationSec) || 0;
          });
          const lTests = testsByLessonId[l.id] || [];
          const scoreTrend = lTests.map(t => ({
            round: t.round,
            score: t.score,
            category: t.test_category,
            date: t.test_date || t.completed_at
          }));
          const scores = lTests.map(t => Number(t.score)).filter(s => !isNaN(s));
          const avgScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

          lessonStatsRows.push({
            exam_id: examId,
            subject_name: l.subject_name,
            unit_name: l.unit_name,
            study_duration_sec: lSec,
            avg_score: avgScore,
            score_trend: scoreTrend,
            category_scores: {},
            test_count: lTests.length
          });
        });
      }

      // 2. 아카이브 종합 테이블에 저장
      const examArchivePayload = {
        id: examId,
        title: curExam.title || '지난 시험',
        start_date: curExam.startDate || '',
        dday: curExam.dday || '',
        actual_avg_score: curExam.actualAvgScore !== undefined ? Number(curExam.actualAvgScore) : null,
        final_scores_text: curExam.finalScoresText || '',
        total_duration_sec: totalDurationSec,
        category_times: categoryTimes,
        weekly_pace: summary.paceTrend || {},
        summary: summary,
        created_at: new Date().toISOString()
      };

      // 2-1. 아카이브 테이블 3종 순차 삽입 (트랜잭션 효과)
      const archRes = await client.from('exam_archives').insert([examArchivePayload]);
      if (archRes.error) throw new Error('exam_archives 저장 실패: ' + archRes.error.message);

      if (subjectStatsRows.length > 0) {
        const subRes = await client.from('archive_subject_stats').insert(subjectStatsRows);
        if (subRes.error) console.warn('archive_subject_stats 저장 알림:', subRes.error.message);
      }

      if (lessonStatsRows.length > 0) {
        const lesRes = await client.from('archive_lesson_stats').insert(lessonStatsRows);
        if (lesRes.error) console.warn('archive_lesson_stats 저장 알림:', lesRes.error.message);
      }

      // 3. 지난 시험 데이터 완전 삭제 (Clean Reset - 요청사항)
      // (1) 일정 전체 삭제
      const delSchedRes = await client.from('schedules').delete().neq('id', '_dummy_');
      if (delSchedRes.error) console.warn('schedules 삭제 알림:', delSchedRes.error.message);

      // (2) 단원 전체 삭제 (CASCADE로 test_records도 함께 삭제됨)
      const delLessonRes = await client.from('lessons').delete().neq('id', -999999);
      if (delLessonRes.error) console.warn('lessons 삭제 알림:', delLessonRes.error.message);

      // 4. 다음 시험 상태 세팅
      if (nextExam.dday) {
        // 과목들의 dday를 다음 시험일로 갱신
        const updateRows = (archivePayload.subjects || []).map(s => ({
          name: s.name,
          dday: nextExam.dday,
          target_score: s.targetScore || 100,
          color: s.color || 'indigo',
          updated_at: new Date().toISOString()
        }));
        await client.from('subjects').upsert(updateRows, { onConflict: 'name' });
      }

      if (nextExam.title) {
        await this.saveSetting('appTitle', nextExam.title);
      }

      return {
        success: true,
        examId: examId,
        message: '성공적으로 아카이브에 통계가 보존되었으며, 새 시험 준비를 위해 단원과 일정이 리셋되었습니다.'
      };
    },

    // ----------------------------------------------------
    // 9. 아카이브 조회 (archive.html 연동)
    // ----------------------------------------------------
    async getExamArchiveList() {
      const client = this.getClient();
      if (!client) return [];

      const { data, error } = await client
        .from('exam_archives')
        .select(`
          id, title, start_date, dday, actual_avg_score, final_scores_text,
          total_duration_sec, created_at
        `)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('getExamArchiveList 오류:', error);
        return [];
      }
      return data || [];
    },

    async getExamArchiveDetail(examId) {
      const client = this.getClient();
      if (!client) return null;

      const [archRes, subRes, lesRes] = await Promise.all([
        client.from('exam_archives').select('*').eq('id', examId).single(),
        client.from('archive_subject_stats').select('*').eq('exam_id', examId),
        client.from('archive_lesson_stats').select('*').eq('exam_id', examId)
      ]);

      if (archRes.error) {
        console.error('getExamArchiveDetail 오류:', archRes.error);
        return null;
      }

      return {
        meta: archRes.data,
        subjects: subRes.data || [],
        lessons: lesRes.data || []
      };
    }
  };

  window.SupabaseService = SupabaseService;
})(window);
