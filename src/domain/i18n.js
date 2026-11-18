'use strict';

/**
 * Pure Domain Internationalization (`en` default + built-in `ko` toggle).
 * Zero DOM or vendor globals.
 */

const DEFAULT_LOCALE = 'en';
const SUPPORTED_LOCALES = Object.freeze(['en', 'ko']);

const DEFAULT_COMPACT_PROMPT =
  'Summarize the current state concisely in internal context only so work can resume seamlessly: preserve exact user goals, confirmed decisions and reasons, edited file paths and key changes, executed checks/results (including failures), remaining work, and constraints/feedback, while condensing finished exploration and long tool outputs to conclusions. Respond with a single confirmation line and end the turn immediately.';

const MESSAGES = Object.freeze({
  en: Object.freeze({
    'compact.label': '[ compact ]',
    'compact.title': 'Run system /compact immediately with configured summary prompt',
    'context.label': '[ context ]',
    'context.title': 'Toggle detailed context & trajectory debug modal',
    'metrics.currentSession': 'current',
    'metrics.limitTitle': 'Session ({session}) context limit: {cw} ({hint})\nClick to open custom input / preset selector (per-session)\nShift+Click to cycle 256K -> 512K -> 900K',
    'metrics.cacheLabel': 'cache',
    'metrics.ctxLabel': 'ctx',
    'metrics.leftLabel': 'left',
    'menu.headerLeft': 'Session Context Limit',
    'menu.headerRight': 'Per-session · 32K~980K',
    'menu.customPlaceholder': 'e.g. 400 or 750K',
    'menu.apply': 'Apply',
    'menu.customHint': 'Supports 32K–980K · Enter to apply · Click outside or Esc to close',
    'menu.saveAsDefault': 'Save {cw} as new-session default ({defCw})',
    'preset.128K': 'Saver (~0.7x)',
    'preset.256K': 'Default quota (1.0x)',
    'preset.384K': 'Mid limit (~1.15x)',
    'preset.512K': 'High (~1.3x quota/turn)',
    'preset.750K': 'Large (~1.6x)',
    'preset.900K': 'Max (~1.8x quota/turn)',
    'preset.customLow': 'Saver (<1.0x)',
    'preset.customMult': 'Custom (~{mult}x est.)',
    'modal.title': 'Trajectory & Context Debug View',
    'modal.inlineStats': '[ inline stats ]',
    'modal.inlineStatsTitle': 'Toggle built-in top Trajectory Stats banner',
    'modal.close': '[ × ]',
    'modal.closeTitle': 'Close (ESC)',
    'modal.loading': 'Loading context telemetry…',
    'modal.noSession': 'Session metadata unavailable (missing cascadeId or RPC transport).',
    'modal.fetchFailed': 'Failed to load telemetry: {error}',
    'modal.cardCtx': 'Context Used / Session Limit ({cw})',
    'modal.cardCache': 'Prompt Cache Hit Rate',
    'modal.cardCacheSub': 'Cache: {cache} · Fresh Input: {input}',
    'modal.cardTraj': 'Trajectory Metadata',
    'modal.cardTrajVal': '{steps} steps · {turns} turns',
    'modal.cardTrajSub': 'Last Turn Max: {max} · Model: {model}',
    'modal.breakdownTitle': 'Context Window Token Breakdown',
    'modal.breakdownTotal': 'Total: {total}',
    'modal.colGroupSource': 'Group / Source',
    'modal.colTokens': 'Tokens',
    'modal.colShare': 'Share',
    'modal.sectionsTitle': 'Prompt Sections ({count})',
    'modal.colSectionTitle': 'Section Title',
    'modal.colSource': 'Source',
    'modal.colSize': 'Size',
    'modal.turnsTitle': 'Recent Generator Turns (Latest {shown} of {total})',
    'modal.trajectoryId': 'Trajectory ID: {id}',
    'modal.colStep': 'Step',
    'modal.colModel': 'Model',
    'modal.colEstCtx': 'Est. Ctx',
    'modal.colCacheRead': 'Cache Read',
    'modal.colFreshInput': 'Fresh Input',
    'modal.colOutputThink': 'Output (+Think)',
    'modal.noTurns': 'No generator turn metadata recorded yet.',
    'modal.charsUnit': '{count} chars',
    'modal.thkSuffix': '(+{count} thk)',
  }),
  ko: Object.freeze({
    'compact.label': '[ compact ]',
    'compact.title': '지정된 요약 프롬프트로 시스템 /compact 즉시 실행',
    'context.label': '[ context ]',
    'context.title': '상세 컨텍스트 디버그 창 열기/닫기',
    'metrics.currentSession': '현재',
    'metrics.limitTitle': '이 세션({session})의 컨텍스트 한도: {cw} ({hint})\n클릭 시 직접 입력 / 프리셋 선택 메뉴 열기 (세션별 독립 적용)\nShift+클릭 시 256K → 512K → 900K 빠른 순환',
    'metrics.cacheLabel': 'cache',
    'metrics.ctxLabel': 'ctx',
    'metrics.leftLabel': 'left',
    'menu.headerLeft': '컨텍스트 한도 설정',
    'menu.headerRight': '세션별 적용 · 32K~980K',
    'menu.customPlaceholder': '예: 400 또는 750K',
    'menu.apply': '적용',
    'menu.customHint': '32K~980K 직접 입력 · Enter 적용 · 바깥 클릭/Esc 닫기',
    'menu.saveAsDefault': '기본값으로 저장 ({cw} → 새 채팅 기본값: {defCw})',
    'preset.128K': '절약 모드 (~0.7x)',
    'preset.256K': '기본 쿼터 (1.0x)',
    'preset.384K': '중간 한도 (~1.15x)',
    'preset.512K': '턴당 약 1.3배 쿼터 소비',
    'preset.750K': '대용량 (~1.6x)',
    'preset.900K': '턴당 약 1.8배 쿼터 소비',
    'preset.customLow': '절약 모드 (<1.0x)',
    'preset.customMult': '직접 지정 (~{mult}x 추정)',
    'modal.title': 'Trajectory & Context Debug View',
    'modal.inlineStats': '[ inline stats ]',
    'modal.inlineStatsTitle': '채팅창 상단 내장 Trajectory Stats 표시 토글',
    'modal.close': '[ × ]',
    'modal.closeTitle': '닫기 (ESC)',
    'modal.loading': '컨텍스트 메타데이터를 불러오는 중…',
    'modal.noSession': '세션 정보(cascadeId 또는 RPC 연결)를 찾을 수 없습니다.',
    'modal.fetchFailed': '메타데이터 조회 실패: {error}',
    'modal.cardCtx': '사용 컨텍스트 / 세션 한도 ({cw})',
    'modal.cardCache': '프롬프트 캐시 적중률',
    'modal.cardCacheSub': '캐시: {cache} · 신규 입력: {input}',
    'modal.cardTraj': 'Trajectory 메타데이터',
    'modal.cardTrajVal': '{steps} steps · {turns} turns',
    'modal.cardTrajSub': '직전 턴 상한: {max} · 모델: {model}',
    'modal.breakdownTitle': '컨텍스트 윈도우 토큰 상세',
    'modal.breakdownTotal': '합계: {total}',
    'modal.colGroupSource': '그룹 / 소스',
    'modal.colTokens': '토큰',
    'modal.colShare': '비중',
    'modal.sectionsTitle': '프롬프트 섹션 ({count})',
    'modal.colSectionTitle': '섹션 제목',
    'modal.colSource': '소스',
    'modal.colSize': '크기',
    'modal.turnsTitle': '최근 생성 턴 ({shown} / {total})',
    'modal.trajectoryId': 'Trajectory ID: {id}',
    'modal.colStep': '스텝',
    'modal.colModel': '모델',
    'modal.colEstCtx': '추정 Ctx',
    'modal.colCacheRead': '캐시 읽기',
    'modal.colFreshInput': '신규 입력',
    'modal.colOutputThink': '출력 (+사고)',
    'modal.noTurns': '생성된 턴 메타데이터가 아직 없습니다.',
    'modal.charsUnit': '{count} chars',
    'modal.thkSuffix': '(+{count} thk)',
  }),
});

function resolveLocale(preferred, hostLanguage) {
  const pref = typeof preferred === 'string' ? preferred.trim().toLowerCase() : '';
  if (pref === 'en' || pref === 'ko') return pref;
  if (pref === 'auto') {
    const lang = typeof hostLanguage === 'string' ? hostLanguage.trim().toLowerCase() : '';
    return lang.startsWith('ko') ? 'ko' : 'en';
  }
  return DEFAULT_LOCALE;
}

function formatMessage(template, vars) {
  if (!vars || typeof vars !== 'object') return template;
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (_, k) =>
    vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''
  );
}

function createTranslator(initialLocale = DEFAULT_LOCALE, hostLanguage = '') {
  let currentLocale = resolveLocale(initialLocale, hostLanguage);

  function setLocale(nextLocale, nextHostLanguage) {
    currentLocale = resolveLocale(nextLocale, nextHostLanguage !== undefined ? nextHostLanguage : hostLanguage);
    return currentLocale;
  }

  function getLocale() {
    return currentLocale;
  }

  function t(key, vars) {
    const dict = MESSAGES[currentLocale] || MESSAGES[DEFAULT_LOCALE];
    const template = dict[key] !== undefined ? dict[key] : (MESSAGES[DEFAULT_LOCALE][key] ?? key);
    return formatMessage(template, vars);
  }

  return {
    getLocale,
    setLocale,
    t,
  };
}

module.exports = {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  DEFAULT_COMPACT_PROMPT,
  MESSAGES,
  resolveLocale,
  formatMessage,
  createTranslator,
};
