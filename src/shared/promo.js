// Promo system (2.4.14): one active promo at a time, shown as a banner in
// the popup. To run a new promo, change ONLY this file + the promo_title
// value in _locales (all 17, the event name). Nothing else changes:
//   - the banner HTML/JS, promo_body / promo_button templates, and the
//     copy + checkout wiring are shared and never change.
//   - promo_body / promo_button take the code and discount from here
//     ($1 placeholders), so they never need re-translating.
//   - only promo_title carries the event name ("Black Friday"), so it is
//     the one locale value a new promo re-translates.
//   - icon is a field here (2.4.20), not in the locale strings, so each
//     sale gets its own icon by changing this one line — e.g. 🎄 for
//     Christmas, 🧧 for Lunar New Year, 🎃 for Halloween. The popup
//     prepends it to the title; the locale promo_title has no icon.
// The banner launches by itself at begin and changes back by itself at
// end (local time): it shows only while begin <= now < end.
export const CURRENT_PROMO = {
  id: 'black-friday-2026',
  code: 'BLACK50',
  discount: 50, // percent off
  icon: '🏷️', // banner icon for this sale
  begin: new Date(2026, 10, 27), // local Nov 27, 2026, 00:00 (Black Friday)
  end: new Date(2026, 11, 1), // local Dec 1, 2026, 00:00 (after Nov 30, 11:59 PM)
};

// Promo calendar through end of 2027 (James's plan, 2026-11-27). Every
// promo's Dodo discount code lives here, so a switch only copies the next
// entry into CURRENT_PROMO above (and updates promo_title in _locales).
// The code names are short and consistent: text + percent off
// (LUNAR50, VALENTINE30). The Dodo code for each promo starts a day
// earlier than begin and expires the day after end, in UTC, so it works
// through the whole promo in every timezone; begin/end here are the
// local banner dates (end is the day after the last day, same as above).
export const PROMO_CALENDAR = [
  { id: 'holiday-season-2026', code: 'HOLIDAY26', discount: 50, icon: '🎄', begin: new Date(2026, 11, 24), end: new Date(2027, 0, 3) },
  { id: 'lunar-new-year-2027', code: 'LUNAR50', discount: 50, icon: '🧧', begin: new Date(2027, 1, 1), end: new Date(2027, 1, 9) },
  { id: 'valentines-day-2027', code: 'VALENTINE30', discount: 30, icon: '💝', begin: new Date(2027, 1, 10), end: new Date(2027, 1, 15) },
  { id: 'easter-2027', code: 'EASTER30', discount: 30, icon: '🐣', begin: new Date(2027, 2, 24), end: new Date(2027, 2, 30) },
  { id: 'golden-week-2027', code: 'GOLDEN40', discount: 40, icon: '🎏', begin: new Date(2027, 3, 29), end: new Date(2027, 4, 6) },
  { id: 'summer-sales-2027', code: 'SUMMER30', discount: 30, icon: '☀️', begin: new Date(2027, 6, 1), end: new Date(2027, 7, 1) },
  { id: 'mid-autumn-2027', code: 'MOON30', discount: 30, icon: '🥮', begin: new Date(2027, 8, 13), end: new Date(2027, 8, 17) },
  { id: 'diwali-2027', code: 'DIWALI40', discount: 40, icon: '🪔', begin: new Date(2027, 9, 27), end: new Date(2027, 9, 30) },
  { id: 'halloween-2027', code: 'HALLOWEEN30', discount: 30, icon: '🎃', begin: new Date(2027, 9, 30), end: new Date(2027, 10, 1) },
  { id: 'singles-day-2027', code: 'SINGLES30', discount: 30, icon: '🛍️', begin: new Date(2027, 10, 8), end: new Date(2027, 10, 13) },
  { id: 'black-friday-2027', code: 'FRIDAY50', discount: 50, icon: '🏷️', begin: new Date(2027, 10, 24), end: new Date(2027, 10, 28) },
  { id: 'holiday-season-2027', code: 'HOLIDAY50', discount: 50, icon: '🎄', begin: new Date(2027, 11, 24), end: new Date(2028, 0, 3) },
];

// True while the promo is live (local time). Pure, so the harness can
// test it without a DOM or chrome APIs.
export function promoActive(promo, now) {
  return !!promo && promo.begin instanceof Date && promo.end instanceof Date &&
    now >= promo.begin && now < promo.end;
}
