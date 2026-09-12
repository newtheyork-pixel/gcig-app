import { griffinLogo } from '../brand/logos.js';

// Combined mark for the auth pages (login, invite, password). The
// bytes live in the JS bundle as a data URI: Cloudflare Polish never
// sees them, which is the only bypass that actually works on this
// zone. onError used to hide a fetched PNG after Polish served WebP
// under image/png; a data URI cannot 404, so a failed mark now
// means a corrupt bundle rather than a CDN rewrite.
export default function AuthBrandMark() {
  return (
    <div className="rounded-xl bg-white px-8 py-5">
      <img
        src={griffinLogo}
        alt="The Griffin Fund"
        width={900}
        height={396}
        className="h-16 w-auto"
        decoding="async"
      />
    </div>
  );
}
