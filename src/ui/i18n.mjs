/**
 * Self-contained UI localization dictionary (en / ko).
 * Separated from core error codes (F2) with zero vendor references.
 */
export const UI_STRINGS = Object.freeze({
  en: Object.freeze({
    title: 'Statusbar',
    connecting: 'Connecting',
    connected: 'Live',
    offline: 'Offline',
    session: 'Session',
    modeAuto: 'Auto',
    modeManual: 'Pinned',
    noSessions: 'No active sessions',
    contextWindow: 'Context Window',
    sourceHost: 'Host',
    sourceSession: 'Session Soft',
    sourceDefault: 'Default Soft',
    softLimitExceeded: 'Soft context limit reached. Run compact to reduce usage.',
    compactBtn: 'compact',
    compactingBtn: 'compacting...',
    contextBtn: 'context',
    tokenBreakdown: 'Token Breakdown',
    stepsLabel: 'steps',
    modelUnavailable: 'Model: unavailable',
    noBreakdown: 'Breakdown unavailable',
    customLimit: 'Soft Context Limit',
    scopeSession: 'This session',
    scopeDefault: 'Default',
    presetHostDefault: 'Host default',
    applyBtn: 'Apply',
    limitSaved: 'Limit updated.',
    limitInvalid: 'Enter an integer between 32,000 and 980,000.',
    limitSaveFailed: 'Failed to save limit.',
    cacheHit: 'Prompt Cache Hit',
    cacheUnavailable: 'Cache telemetry unavailable',
    quotaTitle: 'Account Quota',
    quotaStale: 'Stale',
    quotaUnavailable: 'Quota unavailable',
    compactAccepted: 'Compaction requested...',
    compactCompleted: 'Compaction completed.',
    compactInProgress: 'Compaction already in progress.',
    compactFailed: 'Compaction failed.',
    toggleLocaleLabel: 'KO',
    resetPrefix: 'resets',
  }),
  ko: Object.freeze({
    title: '상태바',
    connecting: '연결 중',
    connected: '실시간',
    offline: '오프라인',
    session: '세션',
    modeAuto: '자동',
    modeManual: '고정',
    noSessions: '활성 세션 없음',
    contextWindow: '컨텍스트 창',
    sourceHost: '호스트',
    sourceSession: '세션 한도',
    sourceDefault: '기본 한도',
    softLimitExceeded: '설정한 소프트 컨텍스트 한도에 도달했습니다. compact 실행을 권장합니다.',
    compactBtn: 'compact',
    compactingBtn: '압축 중...',
    contextBtn: 'context',
    tokenBreakdown: '토큰 상세 내역',
    stepsLabel: '스텝',
    modelUnavailable: '모델: 확인 불가',
    noBreakdown: '상세 내역 없음',
    customLimit: '소프트 컨텍스트 한도',
    scopeSession: '현재 세션',
    scopeDefault: '전체 기본값',
    presetHostDefault: '호스트 기본값',
    applyBtn: '적용',
    limitSaved: '한도가 저장되었습니다.',
    limitInvalid: '32,000 ~ 980,000 사이의 정수를 입력하세요.',
    limitSaveFailed: '한도 저장에 실패했습니다.',
    cacheHit: '프롬프트 캐시 적중률',
    cacheUnavailable: '캐시 정보 없음',
    quotaTitle: '계정 할당량',
    quotaStale: '캐시됨',
    quotaUnavailable: '할당량 정보 없음',
    compactAccepted: '컨텍스트 압축 요청됨...',
    compactCompleted: '컨텍스트 압축 완료.',
    compactInProgress: '이미 압축이 진행 중입니다.',
    compactFailed: '컨텍스트 압축 요청 실패.',
    toggleLocaleLabel: 'EN',
    resetPrefix: '초기화',
  }),
});

/**
 * @param {string} locale
 * @returns {typeof UI_STRINGS.en}
 */
export function getStrings(locale) {
  return locale === 'ko' ? UI_STRINGS.ko : UI_STRINGS.en;
}

/**
 * @param {number | null | undefined} value
 * @returns {string}
 */
export function formatTokenCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '--';
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return String(Math.floor(value));
}

/**
 * @param {string | null | undefined} isoString
 * @returns {string}
 */
export function formatResetTime(isoString) {
  if (typeof isoString !== 'string' || !isoString.trim()) {
    return '--';
  }
  const ms = Date.parse(isoString);
  if (!Number.isFinite(ms)) {
    return isoString;
  }
  const diffMs = ms - Date.now();
  if (diffMs <= 0) {
    return '0m';
  }
  const totalMin = Math.ceil(diffMs / 60_000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
