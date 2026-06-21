// Initialise i18n for zxplay.org: shared common strings from @zxplay/i18n plus
// this app's own strings. Imported once for its side effect in index.jsx.
import {initI18n} from "@zxplay/i18n";

import en from "./locales/en/play.json";
import es from "./locales/es/play.json";
import ru from "./locales/ru/play.json";
import pt from "./locales/pt/play.json";
import pl from "./locales/pl/play.json";
import cs from "./locales/cs/play.json";
import sk from "./locales/sk/play.json";
import ro from "./locales/ro/play.json";
import bg from "./locales/bg/play.json";

initI18n({en, es, ru, pt, pl, cs, sk, ro, bg});
