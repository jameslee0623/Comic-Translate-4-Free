// Simplified -> Traditional (Taiwan) conversion for the local-translate
// test. Opus-MT outputs Simplified Chinese; this converts it with the
// vendored opencc-js bundle (s2twp config: mainland phrases become
// Taiwan usage, e.g. 软件 -> 軟體, not just 软件 -> 軟件).
import { Converter } from './vendor/opencc-cn2t.js';

let s2twp = null;

// Text -> Traditional Chinese (Taiwan). Pure string mapping, no model.
export function toTraditionalTW(text) {
  if (!text) return text;
  if (!s2twp) s2twp = Converter({ from: 'cn', to: 'twp' });
  return s2twp(text);
}
