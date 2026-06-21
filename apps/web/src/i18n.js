// Initialise i18n for code.zxplay.org: shared common strings from @zxplay/i18n
// plus this app's own strings. Imported once for its side effect in index.jsx.
import {initI18n} from "@zxplay/i18n";

import en from "./locales/en/web.json";
import es from "./locales/es/web.json";
import ru from "./locales/ru/web.json";
import pt from "./locales/pt/web.json";
import pl from "./locales/pl/web.json";
import cs from "./locales/cs/web.json";
import sk from "./locales/sk/web.json";
import ro from "./locales/ro/web.json";
import bg from "./locales/bg/web.json";

initI18n({en, es, ru, pt, pl, cs, sk, ro, bg});
