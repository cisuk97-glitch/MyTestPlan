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
      // Simple probe query
      const { data, error } = await client.from('lessons').select('id').limit(1);
      if (error) throw error;
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

        if (subjRes.error) console.warn('subjects 조회 알림:', subjRes.error.message);
        if (lessonRes.error) console.warn('lessons 조회 알림:', lessonRes.error.message);
        if (testRes.error) console.warn('test_records 조회 알림:', testRes.error.message);
        if (schedRes.error) console.warn('schedules 조회 알림:', schedRes.error.message);

        const rawSubjects = subjRes.data || [];
        const rawLessons = lessonRes.data || [];
        const rawTests = testRes.data || [];
        const rawSchedules = schedRes.data || [];
        const rawSettings = settingRes.data || [];

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

        // 2. 과목 구조화
        const subjects = rawSubjects.map(s => {
          return {
            id: 'subj-' + encodeURIComponent(s.name),
            name: s.name,
            dday: s.dday || '',
            targetScore: s.target_score || 100,
            color: s.color || 'indigo',
            lessons: lessonsBySubject[s.name] || []
          };
        });

        // 3. lessons에 등록된 과목명이 subjects에 없으면 자동 합성
        Object.keys(lessonsBySubject).forEach(sName => {
          if (!subjects.find(s => s.name === sName)) {
            subjects.push({
              id: 'subj-' + encodeURIComponent(sName),
              name: sName,
              dday: '',
              targetScore: 100,
              color: 'emerald',
              lessons: lessonsBySubject[sName]
            });
          }
        });

        // 4. 스케줄 정규화
        const schedules = rawSchedules.map(sch => ({
          id: sch.id,
          lessonId: sch.lesson_id,
          subject: sch.subject,
          date: sch.date,
          category: sch.category || '진도계획',
          title: sch.title,
          detail: sch.detail || '',
          progress: sch.progress || 0,
          score: sch.score || '',
          durationSec: sch.duration_sec || 0,
          completed: Boolean(sch.completed)
        }));

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
      const actualScores = curExam.actualScores || {}; // { '영어': 95, '국어': 92 }

      // 1. 현재 시험 통계 데이터 계산
      // (1) 카테고리별 시간 집계
      const categoryTimes = {};
      let totalDurationSec = 0;
      (archivePayload.curSchedules || []).forEach(s => {
        const sec = Number(s.durationSec) || 0;
        const cat = s.category || '진도계획';
        categoryTimes[cat] = (categoryTimes[cat] || 0) + sec;
        totalDurationSec += sec;
      });

      // (2) 과목별 통계 산출
      const subjectStatsRows = [];
      (archivePayload.subjects || []).forEach(subj => {
        let sTotalSec = 0;
        let sAcadSec = 0;
        let sSelfSec = 0;

        (archivePayload.curSchedules || []).filter(sch => sch.subject === subj.name).forEach(sch => {
          const sec = Number(sch.durationSec) || 0;
          sTotalSec += sec;
          if (sch.category === '학원일정' || (sch.category && sch.category.includes('학원'))) {
            sAcadSec += sec;
          } else {
            sSelfSec += sec;
          }
        });

        const finalScore = actualScores[subj.name] !== undefined && actualScores[subj.name] !== '' 
          ? Number(actualScores[subj.name]) 
          : null;

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

      // (3) 단원별 통계 및 회차별 점수 추이 (score_trend) 산출
      // lessons 테이블에서 현재 단원 목록 조회
      const { data: currentLessons } = await client.from('lessons').select('*');
      const { data: allTestRecords } = await client.from('test_records').select('*').order('round', { ascending: true });

      const testsByLessonId = {};
      (allTestRecords || []).forEach(t => {
        if (!testsByLessonId[t.lesson_id]) testsByLessonId[t.lesson_id] = [];
        testsByLessonId[t.lesson_id].push(t);
      });

      const lessonStatsRows = [];
      (currentLessons || []).forEach(l => {
        // 단원별 공부시간
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

        // 카테고리별 평균점수 (VOCAB, UNIT, WRITING)
        const catMap = {};
        lTests.forEach(t => {
          if (!catMap[t.test_category]) catMap[t.test_category] = [];
          catMap[t.test_category].push(Number(t.score));
        });
        const categoryScores = {};
        Object.keys(catMap).forEach(cat => {
          const arr = catMap[cat].filter(s => !isNaN(s));
          categoryScores[cat] = arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
        });

        lessonStatsRows.push({
          exam_id: examId,
          subject_name: l.subject_name,
          unit_name: l.unit_name, // 외래키 없이 독립 문자열 보관 (lessons 삭제에도 안전)
          study_duration_sec: lSec,
          avg_score: avgScore,
          score_trend: scoreTrend,
          category_scores: categoryScores,
          test_count: lTests.length
        });
      });

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
