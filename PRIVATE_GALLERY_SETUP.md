# Private Event Gallery — deployment checklist

Deploy and validate the Firebase backend and the GitHub Pages frontend together before using the private event gallery.

## Firebase setup (project: dj-photo-wall)

1. In Firebase Authentication → Sign-in method, enable **Anonymous** (for guest sessions). Leave Email/Password enabled for the verified DJ admin.
2. Ensure Firebase project has a **Blaze** plan if required by Cloud Functions.
3. From the cloned repository run:
   ```sh
   npm install -g firebase-tools
   firebase login
   firebase use dj-photo-wall
   cd functions && npm install && cd ..
   firebase deploy --only functions,firestore:rules
   ```
4. On the projector, refresh `display.html` and sign in once with the verified DJ admin account. Firebase Authentication persists the session.
5. Open `admin.html`, log in, click **Start new event**, then **Generate guest code**. Give each guest a separate one-use 8-digit code (valid for five minutes before redemption).
6. Guests visit `gallery.html` and redeem. Their session expires after six hours or when the event ID changes / the gallery closes. Media uploaded **after** event creation is tagged with that event; historical uploads are not included.

## Important caveats

- New uploads use authenticated Cloudinary delivery. Guests receive preview and original-download links with the same expiry as their gallery pass. DJ and projector sessions require verified admin sign-in.
- A browser that already loaded images cannot have those pixels retroactively removed, and a guest could take screenshots or share an authorized code.
- Frontend deployment through GitHub Pages and Firebase backend deployment are separate.
- Do not replace live Firestore rules before verifying projector admin authentication, guest code redemption and uploads work.
- The upload page remains available to event attendees. New media records require a valid server-issued upload reservation. Event metadata is readable to associate uploads with the current event.
- Retention applies to newly signed uploads tagged `party_media_retention_v1`. Older Cloudinary uploads and existing Drive masters are outside this workflow. See `PHOTO_WALL_RETENTION.md` for verification and deployment.
- If deploying this for a busy event, test in a private browser with a photo, a video, a used code, an expired code, and a newly started event.
