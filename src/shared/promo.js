// Promo system (2.4.14): one active promo at a time, shown as a banner in
// the popup. To run a new promo, change ONLY this file + the promo_title
// value in _locales (all 17, the event name). Nothing else changes:
//   - the banner HTML/JS, promo_body / promo_button templates, and the
//     copy + checkout wiring are shared and never change.
//   - promo_body / promo_button take the code and discount from here
//     ($1 placeholders), so they never need re-translating.
//   - only promo_title carries the event name ("Black Friday"), so it is
//     the one locale value a new promo re-translates.
// The banner launches by itself at begin and changes back by itself at
// end (local time): it shows only while begin <= now < end.
export const CURRENT_PROMO = {
  id: 'black-friday-2026',
  code: 'BLACK50',
  discount: 50, // percent off
  begin: new Date(2026, 10, 27), // local Nov 27, 2026, 00:00 (Black Friday)
  end: new Date(2026, 11, 1), // local Dec 1, 2026, 00:00 (after Nov 30, 11:59 PM)
};

// True while the promo is live (local time). Pure, so the harness can
// test it without a DOM or chrome APIs.
export function promoActive(promo, now) {
  return !!promo && promo.begin instanceof Date && promo.end instanceof Date &&
    now >= promo.begin && now < promo.end;
}
