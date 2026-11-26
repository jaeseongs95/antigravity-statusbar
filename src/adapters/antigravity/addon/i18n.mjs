/**
 * Self-contained localization & formatting module for the AddonManifest.v1 inline statusbar (SRP).
 */

export function createInlineI18n(initialLocale = 'ko') {
  const STRINGS = {
    en: {
      connecting: 'Statusbar: Connecting…',
      reconnecting: 'Statusbar: Reconnecting…',
      standby: 'Statusbar: Waiting for Sidecar…',
      reloadNow: 'Reload',
      ctx: 'Ctx',
      cache: 'Cache',
      quota: 'Quota',
      quota5h: '5h Limit',
      quotaWeekly: 'Weekly',
      quotaOther: 'Quota',
      quotaReset: 'Reset',
      softLimit: 'Limit Reached',
      autoCompacting: 'Auto-compacting…',
      autoCompactDeferred: 'Compact pending',
      autoResuming: 'Resuming…',
      compactingBadge: 'Compacting…',
      compact: 'compact',
      compacting: '…',
      compactSent: 'Compaction requested',
      compactInProgress: 'Compaction already in progress',
      compactFail: 'Compaction failed',
      noActiveSession: 'No active session found',
      settingsTitle: 'Statusbar',
      tabContext: 'Context',
      tabSettings: 'Settings',
      compactionSettingsTitle: 'Compaction',
      breakdownTitle: 'Token Breakdown',
      limitTitle: 'Session Context Limit',
      limitHint: 'Overrides global limits for this session only. Auto-compacts when reached.',
      globalLimitBtn: 'Global…',
      globalLimitSettingsBtn: 'Open Global Context Limits…',
      globalLimitsSummary: 'Default: {defaultVal} · Per-model overrides: {modelCount}',
      globalModalTitle: 'Global Context Limits',
      priorityHint: 'Priority: This session > Per-model global > All-models default > Host default',
      sessionOverrideWarning: 'This session has its own limit ({val}), overriding global settings.',
      clearSessionLimit: 'Clear session limit',
      globalDefaultCardTitle: 'All-Models Global Default',
      globalDefaultCardHint: 'Applied to sessions without a session or per-model limit.',
      globalDefaultCurrent: 'Saved: {val}',
      globalDefaultUnset: 'Not set (uses host default)',
      modelLimitsCardTitle: 'Per-Model Global Limits',
      modelLimitsCardHint: 'Overrides the all-models default for matching models.',
      useCurrentModel: 'Use current model',
      modelNamePlaceholder: 'Model name (e.g. Gemini 4 Neon (High))',
      selectPreset: 'Preset',
      modelEmpty: 'No per-model global limits configured.',
      invalidModelName: 'Enter a valid model name (1–128 characters).',
      editBtn: 'Edit',
      autoCompactError: 'Auto-compact failed: {msg}',
      autoCompactLabel: 'Auto /compact on limit',
      compactPromptTitle: 'Compaction Prompt (/compact …)',
      compactPromptPlaceholder: 'e.g. Focus on modified files and remaining tasks (blank = default)',
      compactPromptHint: 'Ctrl+Enter to save · blank = default /compact',
      save: 'Save',
      reset: 'Reset',
      limitPlaceholder: 'Custom tokens (32,000 - 980,000)',
      hostDefault: 'Host default',
      scopeSession: 'This session',
      scopeDefault: 'Global default',
      apply: 'Apply',
      applied: 'Saved',
      appliedClamped: 'Saved ({val}) — clamped to model max ({max})',
      appliedMaskedBySession: 'Global default saved ({val}). Current session still uses its own limit ({sessionVal}).',
      limitStatusNormal: 'Active: {eff} ({source}) · Model max {max}',
      limitStatusClamped: 'Set {custom} → clamped to model max {max}',
      sourceSession: 'this session',
      sourceModel: 'model global',
      sourceDefault: 'global default',
      sourceHost: 'host default',
      overModelMax: 'over {max} max',
      invalidLimit: 'Enter 32,000–980,000 or leave blank for host default.',
      steps: 'Steps',
      model: 'Model',
      close: 'Close',
      langLabel: 'Language',
      stale: 'stale',
      addonsTitle: 'Attached Add-ons',
      addonEmpty: 'No add-ons attached. Ask an agent to attach a button.',
      addonOn: 'ON',
      addonOff: 'OFF',
      delBtn: 'Remove',
      cmdSent: 'Sent',
      cmdFail: 'Failed',
      remoteSetupNeeded: 'Statusbar: Connect Sidecar',
      remoteConnTitle: 'Remote Sidecar Connection',
      remoteConnHint: 'First approve your public HTTPS Sidecar host (port 443, e.g. https://sidecar.example.com) under "Allowed HTTPS Hosts (User Consent)" in the Remote Web Addons Drawer, then connect below. Credentials stay in browser storage (ctx.storage) only.',
      remoteUrlPlaceholder: 'https://sidecar.example.com',
      remoteTokenPlaceholder: 'X-Statusbar-Token (16+ chars)',
      remoteConnectBtn: 'Connect',
      remoteDisconnectBtn: 'Disconnect',
      remoteApprovalBadgeApproved: 'HTTPS Approved · Connected',
      remoteApprovalBadgePending: 'HTTPS Approval Required',
      remoteApprovalBadgeUnconfigured: 'Not Connected',
      remoteConnected: 'Host HTTPS approved · Connected ({url})',
      remoteDisconnected: 'Not connected — approve an HTTPS Sidecar host (port 443) in the Remote Web Addons Drawer, then enter URL and token.',
      remoteDisconnectedSaved: 'Disconnected and cleared browser credentials.',
      remoteApprovalRequired: 'HTTPS host not approved ({host}): Open the Remote Web Addons Drawer → "Allowed HTTPS Hosts (User Consent)", approve this domain, then retry.',
      remoteHttpsPort443Only: 'Only standard HTTPS port 443 is allowed by host policy. Enter https://<domain> without a custom port.',
      remoteHostForbidden: 'Loopback or private hosts are blocked on Remote Web net policy. Approve and use a public HTTPS FQDN (port 443).',
      remoteInvalidUrl: 'Enter a valid https:// (or loopback) URL without embedded credentials or query strings.',
      remoteInvalidToken: 'Enter a token of at least 16 characters.',
      remoteAuthFailed: 'Auth failed (HTTP {status}). Check X-Statusbar-Token.',
      remoteUnreachable: 'Cannot reach Sidecar (verify Sidecar status, host HTTPS approval, or network connectivity).',
      remoteSaveFailed: 'Failed to save browser settings ({reason}).',
    },
    ko: {
      connecting: '상태바: 연결 중…',
      reconnecting: '상태바: 재연결 중…',
      standby: '상태바: Sidecar 연결 대기 중…',
      reloadNow: '새로고침',
      ctx: '컨텍스트',
      cache: '캐시',
      quota: '할당량',
      quota5h: '5시간 한도',
      quotaWeekly: '주간한도',
      quotaOther: '할당량',
      quotaReset: '초기화',
      softLimit: '한도 도달',
      autoCompacting: '자동 컴팩션 중…',
      autoCompactDeferred: '압축 대기',
      autoResuming: '자동 재개 중…',
      compactingBadge: '컴팩션 중…',
      compact: 'compact',
      compacting: '…',
      compactSent: '컴팩션 요청됨',
      compactInProgress: '이미 컴팩션 진행 중',
      compactFail: '컴팩션 실패',
      noActiveSession: '활성 세션을 찾을 수 없습니다.',
      settingsTitle: '상태바',
      tabContext: '컨텍스트',
      tabSettings: '설정',
      compactionSettingsTitle: '컴팩션 설정',
      breakdownTitle: '토큰 구성',
      limitTitle: '현재 세션 컨텍스트 한도',
      limitHint: '이 세션에만 우선 적용되며, 한도 도달 시 자동 /compact를 실행합니다.',
      globalLimitBtn: '전역 설정…',
      globalLimitSettingsBtn: '전역 컨텍스트 한도 창 열기…',
      globalLimitsSummary: '일괄 기본값: {defaultVal} · 모델별 개별 설정: {modelCount}개',
      globalModalTitle: '전역 컨텍스트 한도 설정',
      priorityHint: '우선순위: 현재 세션 > 모델별 전역 > 일괄 전역 > 호스트 기본값',
      sessionOverrideWarning: '현재 세션 개별 한도({val})가 전역 설정보다 우선 적용 중입니다.',
      clearSessionLimit: '세션 한도 해제',
      globalDefaultCardTitle: '일괄 전역 기본값 (모든 모델 공통)',
      globalDefaultCardHint: '세션 한도나 모델별 전역 한도가 없는 모든 세션에 적용됩니다.',
      globalDefaultCurrent: '저장됨: {val}',
      globalDefaultUnset: '미설정 (호스트 기본값 사용)',
      modelLimitsCardTitle: '모델별 전역 한도',
      modelLimitsCardHint: '일괄 전역 기본값보다 우선하며, 해당 모델을 쓰는 세션에 적용됩니다.',
      useCurrentModel: '현재 모델 채우기',
      modelNamePlaceholder: '모델명 (예: Gemini 4 Neon (High))',
      selectPreset: '프리셋',
      modelEmpty: '등록된 모델별 전역 한도가 없습니다.',
      invalidModelName: '모델명을 1~128자로 입력하세요.',
      editBtn: '수정',
      autoCompactError: '자동 컴팩션 실패: {msg}',
      autoCompactLabel: '한도 도달 시 자동 /compact',
      compactPromptTitle: '컴팩션 요약 문구 (/compact …)',
      compactPromptPlaceholder: '예: 수정 중인 파일과 남은 작업 위주로 요약해줘 (비우면 기본)',
      compactPromptHint: 'Ctrl+Enter로 저장 · 비우면 기본 /compact',
      save: '저장',
      reset: '초기화',
      limitPlaceholder: '직접 입력 (32,000 ~ 980,000)',
      hostDefault: '호스트 기본값',
      scopeSession: '현재 세션',
      scopeDefault: '일괄 전역',
      apply: '적용',
      applied: '저장되었습니다.',
      appliedClamped: '{val} 저장됨 (모델 최대 {max}로 제한 적용)',
      appliedMaskedBySession: '전역 기본값({val}) 저장됨 · 현재 세션은 개별 한도({sessionVal})가 우선 적용 중입니다.',
      limitStatusNormal: '적용 중: {eff} ({source}) · 모델 최대 {max}',
      limitStatusClamped: '{custom} 설정됨 → 모델 최대 {max}로 제한 적용됨',
      sourceSession: '현재 세션',
      sourceModel: '모델별 전역',
      sourceDefault: '일괄 전역',
      sourceHost: '호스트 기본값',
      overModelMax: '최대 {max} 초과',
      invalidLimit: '32,000~980,000 사이 숫자 또는 비움(기본값)을 입력하세요.',
      steps: '스텝',
      model: '모델',
      close: '닫기',
      langLabel: '언어 선택',
      stale: '오래됨',
      addonsTitle: '연결된 애드온',
      addonEmpty: '연결된 애드온이 없습니다. 에이전트에게 버튼 추가를 요청하세요.',
      addonOn: '켜짐',
      addonOff: '꺼짐',
      delBtn: '삭제',
      cmdSent: '전송됨',
      cmdFail: '전송 실패',
      remoteSetupNeeded: '상태바: 원격 연결 설정',
      remoteConnTitle: '원격 Sidecar 연결',
      remoteConnHint: '먼저 Remote Web Addons 드로어의 "Allowed HTTPS Hosts (User Consent)"에서 공인 HTTPS 도메인(포트 443, 예: https://sidecar.example.com)을 승인한 뒤 아래에서 연결하세요. 자격 증명은 브라우저(ctx.storage)에만 저장되며 번들에 포함되지 않습니다.',
      remoteUrlPlaceholder: 'https://sidecar.example.com',
      remoteTokenPlaceholder: 'X-Statusbar-Token (16자 이상)',
      remoteConnectBtn: '연결',
      remoteDisconnectBtn: '연결 해제',
      remoteApprovalBadgeApproved: 'HTTPS 승인됨 · 연결됨',
      remoteApprovalBadgePending: 'HTTPS 승인 필요',
      remoteApprovalBadgeUnconfigured: '미연결',
      remoteConnected: '호스트 HTTPS 승인 확인 · 연결됨 ({url})',
      remoteDisconnected: '연결되지 않음 — Remote Web Addons 드로어에서 공인 HTTPS 도메인(포트 443)을 승인한 뒤 주소와 토큰을 입력하세요.',
      remoteDisconnectedSaved: '연결을 해제하고 브라우저 자격 증명을 삭제했습니다.',
      remoteApprovalRequired: 'HTTPS 도메인 미승인({host}): Remote Web Addons 드로어 → "Allowed HTTPS Hosts (User Consent)"에서 이 호스트를 먼저 승인한 뒤 다시 연결하세요.',
      remoteHttpsPort443Only: '호스트 정책상 표준 HTTPS 포트(443)만 허용됩니다. 포트 번호 없이 https://<도메인> 형식으로 입력하세요.',
      remoteHostForbidden: 'Remote Web 네트워크 정책상 루프백·사설 주소는 차단됩니다. 공인 HTTPS 도메인(포트 443)을 승인해 연결하세요.',
      remoteInvalidUrl: '유효한 https:// (또는 루프백) 주소를 입력하세요 (자격 증명·쿼리 불가).',
      remoteInvalidToken: '16자 이상의 토큰을 입력하세요.',
      remoteAuthFailed: '인증 실패 (HTTP {status}). X-Statusbar-Token을 확인하세요.',
      remoteUnreachable: 'Sidecar에 연결할 수 없습니다 (Sidecar 실행 여부, 호스트 HTTPS 승인 상태 또는 네트워크를 확인하세요).',
      remoteSaveFailed: '브라우저 설정 저장 실패 ({reason}).',
    },
  };

  const KO_BREAKDOWN_LABELS = {
    System: '시스템',
    'System Prompt': '시스템 프롬프트',
    'Chat Messages': '대화 메시지',
    'User Messages': '사용자 메시지',
    'Assistant Messages': '응답 메시지',
    Tools: '도구',
    'Tool Results': '도구 결과',
    'Files / Context': '파일 · 컨텍스트',
    Thoughts: '사고 과정',
    Other: '기타',
  };

  let locale = initialLocale === 'en' ? 'en' : 'ko';

  function getLocale() {
    return locale;
  }

  function setLocale(next) {
    if (next === 'ko' || next === 'en') {
      locale = next;
    }
    return locale;
  }

  function t() {
    return STRINGS[locale] || STRINGS.ko;
  }

  function formatTokens(n) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '--';
    if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return String(Math.round(n));
  }

  function formatTemplate(tpl, vars) {
    return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) =>
      Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : '',
    );
  }

  function localizeBreakdownLabel(rawLabel) {
    if (locale === 'ko' && Object.prototype.hasOwnProperty.call(KO_BREAKDOWN_LABELS, rawLabel)) {
      return KO_BREAKDOWN_LABELS[rawLabel];
    }
    return rawLabel;
  }

  function parseValidTimestamp(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const ms = Date.parse(trimmed);
    if (!Number.isFinite(ms)) return null;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function formatLocalTimeHHMM(raw) {
    const d = parseValidTimestamp(raw);
    if (!d) return '';
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function formatLocalDateTime(raw) {
    if (typeof raw !== 'string') return '';
    const trimmed = raw.trim();
    if (!trimmed) return '';
    const d = parseValidTimestamp(trimmed);
    if (!d) return trimmed;
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  return Object.freeze({
    getLocale,
    setLocale,
    t,
    formatTokens,
    formatTemplate,
    localizeBreakdownLabel,
    formatLocalTimeHHMM,
    formatLocalDateTime,
  });
}
