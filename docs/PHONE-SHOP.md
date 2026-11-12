# Vellivex phone storefront

The physical-phone catalogue is separate from the experimental app services.
`server/phone-shop.mjs` supplies the public catalogue, phone purchase terms,
order privacy notice, styles, public navigation and sitemap additions.
`server/phone-shop-config.mjs` contains only public Stripe payment URLs.

The initial products are Pixel 9a 128GB Obsidian, new at GBP 429 and refurbished
at GBP 349. These are full paid preorders with tracked UK delivery included
within 14 calendar days of payment. International orders require a separate
quote. One handset is available per checkout. No subscription or VAT is added.
The refurbished specification permits cosmetic wear and requires at least
80% battery health. The seller must source units meeting the advertised terms.

The owner confirmed an existing configured handset and authorised this launch.
That report does not establish new independent testing of all Vellivex apps.
The storefront retains beta labels and distinguishes Signal encryption from
ordinary carrier calls/SMS and the public shared VNumber inbox.

## Runtime and deployment

Wrap the original site Worker inside its existing app-access wrapper:
`withAppAccess(withPhoneShop(original, config), existingOptions)`.
Preserve all original modules, download assets, bindings and access options.
Do not deploy the generic build over the current live native 0.1.4 release;
the generic source checkout still packages the older 0.1.3 native inputs.

Supply only the already designated public business correspondence information
in `PHONE_SHOP_SELLER_JSON`, containing `name` and `addressLines`. Do not copy
account-management details, identity documents or residential-owner records
into that binding or the public repository. Missing valid seller information
must leave the catalogue readable but the payment buttons unavailable.

Only the fixed public checkout destinations are linked. The phone module does
not receive card details, charge payments, store orders or interpret a visit
to `/phones/thanks` as proof of payment. Stripe is the source of payment status
and shipping information. Order fulfilment remains an operator responsibility.

Stripe payment links require acceptance of the phone purchase terms, collect a
UK shipping address and name, and show the full-payment preorder notice. No
recurring price, paid invoice-generation feature, provider calling or SMS flag
is enabled by this launch.

## Verification

Run the phone storefront tests and existing app-access regression tests.
Run the required complete build and artifact validation with the original
native build inputs available. Review both hosted checkout pages without
making a live test purchase. Confirm prices, shipping restriction, terms links,
public seller branding and product condition. Recheck the exact deployed
module hashes and preserved settings after promotion.

## Search and launch article

The catalogue and phone documents have canonical URLs, distinct page titles
and descriptions, and Open Graph/Twitter metadata. The shared social image is
`/media/vellivex-privacy-phones.png`, a public 1200 by 630 PNG provided by the
separate media module. It must remain available without an app login.

Product/ProductGroup structured data and the visible product cards use the
separate clean manufacturer image at `/media/pixel-9a-obsidian.jpg`, not the
promotional social poster. This unchanged 512 by 383 JPEG shows the full front,
side and back of an Obsidian Pixel 9a. Its source is the official Google Store
Pixel 9a Obsidian gallery, retrieved on 12 November 2026:

- https://store.google.com/gb/product/pixel_9a?hl=en-GB
- https://lh3.googleusercontent.com/YfrFPJR3mybyPqN75HDidiLlY8Glx0pXXVQh2u2GRwDu3HUycABU_a35kdzgpWzLLJ1Ifa3yz8n5vVbdgIpOCzx5K-xg2IJYRCg

The manufacturer image remains Google's material, distinct from the repository's
GPL-licensed source code. No endorsement or transfer of image rights is claimed.
Visible captions explain that software and refurbished condition may vary.
This implementation does not claim Google Merchant Center approval.

The existing `robots.txt` wildcard group gains only `Allow: /phones`,
`Allow: /media/vellivex-privacy-phones` and
`Allow: /media/pixel-9a-obsidian.jpg`. Existing exclusions and other user-agent
groups remain intact; shared multi-agent groups are left unchanged. These
additions are idempotent and do not open private or application routes.

The original launch guide is at `/blog/grapheneos-privacy-phones-uk`, dated
12 November 2026. It links to the catalogue, conditions, purchase terms and
official GrapheneOS/Signal guidance. The wrapper adds one idempotent card to
the existing blog index's `section.products` and a guide link to the catalogue.
Other blog article responses are not modified. The sitemap includes the guide
and public phone pages, but never the payment-return page.

The catalogue contains one server-rendered JSON-LD graph with a ProductGroup,
two condition variants and a BreadcrumbList. Product conditions, GBP prices,
PreOrder availability and free GB shipping match the visible offer. Offers are
omitted when valid seller details or the corresponding trusted checkout link
are missing. There are no invented ratings, reviews, GTINs, stock counts,
price-validity dates or handling/transit-time splits.

The two handsets differ by condition. Schema.org represents this with
`variesBy: https://schema.org/itemCondition`; Google's documented product
variant axes do not currently include condition. Individual Product/Offer data
is supplied, but variant rich-result eligibility is not claimed or guaranteed.
The guide contains BlogPosting and BreadcrumbList data with its actual
publication date and Vellivex as the author/publisher.

JSON-LD is serialized with HTML-significant characters escaped. Each response
permits only the SHA-256 hash of that exact data block in its script CSP. It
does not permit arbitrary inline scripts, external scripts or unsafe-inline.
The existing app-access wrapper and unrelated route policies are preserved.

Source guidance checked for this implementation:

- https://developers.google.com/search/docs/appearance/structured-data/product-variants
- https://developers.google.com/search/docs/appearance/structured-data/merchant-listing
- https://developers.google.com/search/docs/appearance/structured-data/article
- https://developers.google.com/search/docs/appearance/structured-data/breadcrumb
- https://support.google.com/merchants/answer/12158684

Validate the schema fields and hashes, article dates, visible offer consistency,
navigation/sitemap links and public media responses before deployment. A valid
implementation makes the pages discoverable and understandable; it does not
establish that Google has indexed them or will display a rich result.
