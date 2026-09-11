import { useState } from 'react';

// Combined mark for the auth pages (login, invite, password). Hide the
// whole white chip if the file fails: onError used to set display:none
// on the <img> and leave an empty rounded box, which is what "the
// logo is missing" looks like on Safari after Cloudflare Polish served
// a WebP with a PNG Content-Type.
export default function AuthBrandMark() {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <div className="rounded-xl bg-white px-8 py-5">
      <img
        src="/griffin-logo.png"
        alt="The Griffin Fund"
        width={1131}
        height={498}
        className="h-16 w-auto"
        decoding="async"
        onError={() => setFailed(true)}
      />
    </div>
  );
}
