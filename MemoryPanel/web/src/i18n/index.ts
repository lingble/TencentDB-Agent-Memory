/**
 * i18n initialization module
 *
 * The UI is English-only: en-US is the sole resource, the default language
 * and the fallback. The i18next framework is kept so components continue to
 * use t() for all user-visible text.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { enUS } from './en-US';

i18n.use(initReactI18next).init({
  resources: {
    'en-US': { translation: enUS },
  },
  lng: 'en-US',
  fallbackLng: 'en-US',
  interpolation: {
    escapeValue: false,
  },
  react: {
    useSuspense: false,
  },
});

export default i18n;
