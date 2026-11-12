# Photo wall verification — 2026-11-11

Firebase project: `dj-photo-wall`, Standard Firestore `(default)`.

## Changes

- New media must use the v3 private upload reservation and authenticated Cloudinary URL. Removed the legacy-version bypass. Initial likes and reaction totals must be zero; uploader names are limited to 24 characters.
- Guest likes require a current event pass, current-event media and exactly a +1 integer increment. DJ moderation updates remain available.
- Gallery closes when a pass changes or its verification listener fails; repeated likes update the visible count correctly. Duplicate code submissions are guarded.
- Reaction holds cancel when the selected media/session changes or the window loses focus.
- Gift functions reject nested Firestore paths in media IDs.

## Passed

- All HTML inline JavaScript parses; backend syntax checks pass.
- `cd functions && npm test`: 13 tests covering code reuse, wallet preservation, gift prices and permissions, expired/closed events, nested paths, quick taps, scrolling and hold cancellation.
- `functions/check-rules.cjs`: 14 Firebase Rules API cases covering valid private uploads, forged public URLs, seeded likes, valid/invalid increments, public read denial, valid comments, impersonation, length limits and DJ-only deletion. Run with an installed `firebase-tools`, or set `FIREBASE_TOOLS_LIB` to its `lib/` directory. Uses the normal connected Firebase CLI account.
- Live upload reservation, actual private PNG upload, Firestore guest posting and public read denial. Temporary queue document removed. Private test asset remains under the existing tagged retention policy.
- Live callable endpoints reject unauthenticated redemption, media signing and gifts.
- Live upload, reaction, gallery and projector pages returned HTTP 200 before publishing.
- Firestore rules and `sendPhotoGift` / `sendAdminPhotoGift` deployed successfully. Other functions and retention configuration preserved.

## Remaining manual verification

The interactive browser timed out twice. A DJ-authenticated end-to-end browser session was therefore unavailable. Verify a fresh code, reused/expired code, gallery refresh and revocation, photo and video playback, all four gift animations, face halos, hold controls, and comment posting/deletion on a real projector/phone. Successful API and mocked tests do not establish visual behavior or live concurrent redemption behavior.

I've set up prototype Security Rules to keep the data in Firestore safe. They are designed to be secure for private upload reservations, current-event access, validated likes and event comments. However, you should review and verify them before broadly sharing your app. If you'd like, I can help you harden these rules.
