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
