# Private Event Gallery — deployment checklist

The code is committed, but privacy is **NOT enabled** until the Firebase backend is deployed and validated.

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

- Firestore protects the **gallery listing**, but media URLs use public Cloudinary delivery; someone who already knows a direct asset URL can still open it. Strict media-level privacy requires private/authenticated Cloudinary delivery and a server-side signed URL solution.
- A browser that already loaded images cannot have those pixels retroactively removed, and a guest could take screenshots or share an authorized code.
- Frontend deployment through GitHub Pages and Firebase backend deployment are separate.
- Do not replace live Firestore rules before verifying projector admin authentication, guest code redemption and uploads work.
- Existing `upload.html` remains publicly accessible so event attendees can submit without signing in; the event metadata is readable to associate new uploads. Public create is an intentional current capability.
- If deploying this for a busy event, test in a private browser with a photo, a video, a used code, an expired code, and a newly started event.
