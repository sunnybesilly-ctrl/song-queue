# Private Event Gallery

GitHub Pages serves the gallery, the DJ controls, and the projector. Firebase project `dj-photo-wall` manages guest passes and private media. The separate song request and music display pages use their existing setup.

## Set up Firebase

1. Confirm the default Firestore database and `dj-photo-wall.firebasestorage.app` bucket in Firebase Console. Cloud Storage and deployed Cloud Functions require the Blaze plan. Keep the bucket private in Google Cloud IAM.
2. In Firebase Authentication, enable **Anonymous** for uploads and gallery guests and **Email/Password** for the verified DJ account. Add `sunnybesilly-ctrl.github.io` to Authorized domains. Use the existing verified DJ account for both the control room and projector.
3. Sign in to the Firebase CLI. Install the function dependencies and check the rules with the Firebase emulators or a test project before touching the live app. Test the change set together before publishing it to GitHub Pages.
4. Set the bucket's allowed browser origin and deploy the backend from this repository. The first Storage rules deploy may ask to grant the Storage rules service access to Firestore. The Functions runtime account needs Firestore access and object read, create, and delete permissions on this bucket.
   ```sh
   npm --prefix functions install
   gcloud storage buckets update gs://dj-photo-wall.firebasestorage.app --cors-file=gallery-cors.json
   npx -y firebase-tools@latest deploy --project dj-photo-wall --only firestore:rules,storage,functions
   ```
5. Coordinate the backend deploy and the GitHub Pages release outside an event. The old frontend uploads through Cloudinary, and the new rules accept media records through the new backend. Refresh the projector and DJ pages after GitHub Pages updates.

## Test the release

- Sign into `admin.html` and `display.html` as the verified DJ. Start an event, upload a photo and a video through `upload.html`, and check previews, playback, downloads, reactions, and trim and rotation controls.
- Open `gallery.html` in a separate private window. Confirm signed-out and anonymous users without a code cannot query media or fetch a file. Generate a code, redeem it, and check that another browser cannot reuse it. Check an expired code, one like per guest, and gallery access after refresh.
- Close the event, then start another one. Confirm that the old gallery closes and that an old pass cannot fetch prior files or list the new event. Also test an unfiltered media query and direct file requests without authorization.
- Check the separate song request page and music queue display on GitHub Pages.

## Operating details

- Each invitation is single-use, expires after five minutes, and grants up to six hours of access. Closing or replacing the event revokes new reads immediately. Keep the DJ console signed in during an event.
- Uploads open while an event is active. An attendee can submit under an anonymous identity before redeeming a gallery invite. Photos and videos are limited to 75 MB and need a format supported by the viewing browser. Firebase Storage stores the original video and the projector applies its trim points during playback.
- Older Cloudinary items remain available in the DJ library and projector. They are excluded from guest albums. Previously shared Cloudinary links retain their original access until the assets are made private or removed in Cloudinary.
- New items are served as authenticated file reads. A file already saved by an attendee stays with them.
- Consider a bucket lifecycle policy for the `gallery-incoming/` prefix to remove interrupted uploads and Firestore TTL on `expiresAt` for `gallery_codes`, `gallery_access`, and `gallery_attempts`. Expiration checks are enforced independently of cleanup.
