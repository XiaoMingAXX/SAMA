import { translate } from './locales.mjs';

export const LANGUAGE_STORAGE_KEY = 'loam.language';
let language = 'zh';
try { if (localStorage.getItem(LANGUAGE_STORAGE_KEY) === 'en') language = 'en'; } catch { /* Storage may be unavailable in private browsers. */ }
export const getLanguage = () => language;
export const t = (source, parameters) => translate(language, source, parameters);
export function applyTranslations(root = document) {
  const nodes = [...(root.matches?.('[data-i18n]') ? [root] : []), ...root.querySelectorAll('[data-i18n]')];
  for (const element of nodes) element.textContent = t(element.dataset.i18n);
  for (const attribute of ['title','aria-label','placeholder','alt']) {
    const selector = `[data-i18n-${attribute}]`;
    const elements = [...(root.matches?.(selector) ? [root] : []), ...root.querySelectorAll(selector)];
    for (const element of elements) element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
  }
}
export function setLanguage(next) {
  if (!['zh','en'].includes(next)) return;
  language = next;
  try { localStorage.setItem(LANGUAGE_STORAGE_KEY, language); } catch { /* Switching still works without persistent storage. */ }
  document.documentElement.lang = language === 'en' ? 'en-SG' : 'zh-CN';
  applyTranslations();
  document.querySelectorAll('[data-language]').forEach(button => {
    const selected = button.dataset.language === language;
    button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected));
  });
  window.dispatchEvent(new CustomEvent('loam:languagechange', { detail: { language } }));
}
