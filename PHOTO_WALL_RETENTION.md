# Photo Wall archive and retention

The Photo Wall inventory follows Cloudinary's `party_media` tag for images and videos in the existing Photo Wall account. The scheduled worker runs every 15 minutes. It also finds tagged uploads that never reached Firestore or were removed from the live queue.

The worker downloads the original Cloudinary upload and writes it to the private Drive master folder. Firestore stores a server-only job per Cloudinary asset and version. Before accepting a copy, the worker checks its parent folder, size, SHA-256, asset and version metadata, trash state, and sharing permissions. A failed request is retried. Drive file IDs are reserved before upload so a retry after an ambiguous response reuses the same file. The worker never deletes Drive masters.

After four days, cleanup rechecks the Cloudinary asset and its bytes, rechecks the private Drive copy, and requests Cloudinary deletion by asset ID with CDN invalidation. The four days start at the later of the Cloudinary creation time and the current version time. Cloudinary CDN invalidation can take time to propagate. A failed backup or recheck keeps the source in Cloudinary.

## Deploy and validate

1. Deploy only the four Photo Wall functions to `dj-photo-wall`. Deploy the Firestore rules and publish the Photo Wall pages after checking the functions. The existing four gallery-event functions remain in place.
2. Set `PHOTO_DRIVE_ARCHIVE_FOLDER` to the private archive folder ID in the Functions environment. Grant the Functions runtime identity `Secret Manager Secret Accessor` on each of the three specific secrets. Use the existing Secret Manager versions for `cloudinary-api-key`, `cloudinary-api-secret`, and `google-drive-token`. The Drive secret must contain an OAuth refresh credential with `refresh_token`, `client_id`, and `client_secret`. A scoped credential needs write access to the existing archive folder. If a `drive.file` credential cannot see the folder, explicitly authorize that folder for the same OAuth app, then add an updated version securely in Secret Manager.
3. Run `firebase-schedule-retainPhotoWallMedia-us-central1` from Cloud Scheduler. Check logs and `photo_retention_jobs` for a `verified` record. Confirm its matching original opens from the configured Drive folder and has no public sharing. Test a photo and a video on the projector and with a fresh guest code.
4. Set `PHOTO_RETENTION_DELETE_ENABLED=true` in the Functions environment and redeploy only `retainPhotoWallMedia` after successful live backup verification. Eligible jobs are revisited automatically. Remove the setting and redeploy the worker to suspend cleanup while backups continue.

New uploads use Cloudinary authenticated delivery. The guest gallery issues time-limited preview and download links that expire at the guest pass deadline. When an event closes, the gallery closes and the server stops issuing links. Previously issued links reach their original expiry. Pre-existing public uploads are excluded from the new guest gallery and remain on their original delivery type until verified cleanup. Admin and projector sessions can still view them. The public reaction screen shows the uploader's name without a private media thumbnail.

A Drive master contains the original **uploaded to Cloudinary**. The guest upload page can crop and resize photos before that upload. Media without the Photo Wall tag, and files larger than 100 MiB, require separate archive handling. Oversize tagged jobs log a failure and keep their Cloudinary source.
