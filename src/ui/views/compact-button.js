'use strict';

/**
 * Compact Action Button Builtin Adapter.
 * Uses pure UI localization (`i18n`) without direct driver imports.
 */

const { DEFAULT_LOCALE, createTranslator } = require('../../domain/i18n');

function createCompactButtonAdapter({ runCompactForInputBox, translator }) {
  const tr = translator || createTranslator(DEFAULT_LOCALE);
  return {
    id: 'compact',
    slot: 'right',
    order: 10,
    builtin: true,
    className: 'agy-ctx-btn agy-ctx-btn-compact',
    label: () => tr.t('compact.label'),
    title: () => tr.t('compact.title'),
    onClick({ inputBox }) {
      runCompactForInputBox(inputBox);
    },
  };
}

module.exports = {
  createCompactButtonAdapter,
};
