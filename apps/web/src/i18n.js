// Initialise i18n for code.zxplay.org: shared common strings from @zxplay/i18n
// plus this app's own strings. Imported once for its side effect in index.jsx.
import {initI18n} from "@zxplay/i18n";

import bg from "./locales/bg/web.json";
import cs from "./locales/cs/web.json";
import el from "./locales/el/web.json";
import en from "./locales/en/web.json";
import es from "./locales/es/web.json";
import it from "./locales/it/web.json";
import pl from "./locales/pl/web.json";
import pt from "./locales/pt/web.json";
import ro from "./locales/ro/web.json";
import ru from "./locales/ru/web.json";
import sk from "./locales/sk/web.json";

initI18n({bg, cs, el, en, es, it, pl, pt, ro, ru, sk});
