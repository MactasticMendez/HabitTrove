import { getRequestConfig } from 'next-intl/server';
import { loadSettings } from '@/app/actions/data'; // Adjust path as necessary
import { supportedLanguages } from '@/lib/security-validation'

export default getRequestConfig(async () => {
  // Load settings to get the user's preferred language
  const settings = await loadSettings();
  const locale = supportedLanguages.has(settings.system.language) ? settings.system.language : 'en';

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default
  };
});
