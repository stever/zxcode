// Initialise i18n for code.zxplay.org: shared common strings from @zxplay/i18n
// plus this app's own strings. Imported once for its side effect in index.jsx.
import {initI18n} from "@zxplay/i18n";

import en from "./locales/en/web.json";
import es from "./locales/es/web.json";
import ru from "./locales/ru/web.json";

initI18n({en, es, ru});
