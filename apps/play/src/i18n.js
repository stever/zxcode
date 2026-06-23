// Initialise i18n for zxplay.org: shared common strings from @zxplay/i18n plus
// this app's own strings. Imported once for its side effect in index.jsx.
import {initI18n} from "@zxplay/i18n";

import bg from "./locales/bg/play.json";
import cs from "./locales/cs/play.json";
import el from "./locales/el/play.json";
import en from "./locales/en/play.json";
import es from "./locales/es/play.json";
import it from "./locales/it/play.json";
import pl from "./locales/pl/play.json";
import pt from "./locales/pt/play.json";
import ro from "./locales/ro/play.json";
import ru from "./locales/ru/play.json";
import sk from "./locales/sk/play.json";

initI18n({bg, cs, el, en, es, it, pl, pt, ro, ru, sk});
