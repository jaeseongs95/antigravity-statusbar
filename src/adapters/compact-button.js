'use strict';

function createCompactButtonAdapter({ runCompactForInputBox }) {
  return {
    id: 'compact',
    slot: 'right',
    order: 10,
    builtin: true,
    className: 'agy-ctx-btn agy-ctx-btn-compact',
    label: '[ compact ]',
    title: '지정된 요약 프롬프트로 시스템 /compact 즉시 실행',
    onClick({ inputBox }) {
      runCompactForInputBox(inputBox);
    },
  };
}

module.exports = {
  createCompactButtonAdapter,
};
