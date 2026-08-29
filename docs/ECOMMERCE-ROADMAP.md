# Justflows Ecommerce Roadmap

This document preserves the intended feature scope for a WooCommerce-class
commerce platform on Justflows. It is a product and architecture roadmap, not
a promise that every feature ships in the first Shop release.

The roadmap deliberately separates the required commerce engine from payment,
carrier, tax, and specialist product modules. `justflows.shop` must remain a
complete, usable shop without a managed Justflows service, while stable adapter
contracts let merchants choose Justflows-managed services or bring their own
providers and credentials.

## Product principles

- **Complete core:** catalog, cart, checkout, orders, inventory, manual payment,
  basic shipping, configurable tax, refunds, and customer accounts work without
  paid services.
- **Merchant choice:** payment, tax, shipping, storage, and notification providers
  use replaceable adapters. Bring-your-own credentials and Justflows-managed
  services use the same contracts.
- **Server-authoritative commerce:** the browser never decides prices, discounts,
  tax, shipping, stock, payment state, or order totals.
- **Transactional data:** catalog products are Content entries of type `product`.
  `shop_products` holds commerce fields (SKU, price, inventory flags) keyed by
  the product's translation group (`content_id`), so every locale shares one
  commerce row. Orders, payments, stock movements, refunds, fulfillments, and
  returns use dedicated Shop tables. Store identity lives in `shop_stores`, not
  `site_settings`.
- **Jurisdiction-agnostic tax:** core provides a configurable tax engine and does
  not claim to determine a merchant's legal obligations. Automated tax services
  are adapters.
- **Extension-first boundaries:** product types, gateways, carriers, tax
  providers, promotions, fulfillment services, and storefront blocks have stable
  SDK contracts.
- **Accessible and international:** admin and storefront flows support keyboard
  use, localized content, address formats, currencies, units, and translated
  notifications.
- **Auditable and recoverable:** important state transitions are idempotent,
  append to an audit trail, and can be reconciled after partial external failure.
- **All supported databases:** persistence and migrations support PostgreSQL,
  MySQL, and MariaDB.

## Plugin and package boundaries

### Main plugin: `justflows.shop`

Shop development lives in the plugin registry's
[`plugins/ecommerce`](https://github.com/JustFlows/plugin-registry-service/tree/main/plugins/ecommerce).
CE does not ship Shop, register it as a bundled plugin in product docs, or add
Shop routes to core. Production sites install `justflows.shop` from the plugin
registry. Companion modules
(`justflows.payments`, `justflows.shipping-*`, and so on) follow the same path.

The main Shop plugin owns:

- Store configuration
- Product catalog and product storefront
- Attributes and variations
- Price calculation contracts
- Inventory and stock reservations
- Cart and checkout
- Customer commerce accounts
- Orders and order state transitions
- Manual payment methods
- Basic shipping zones and methods
- Configurable tax rules
- Discounts and coupons
- Refund records
- Commerce emails and documents
- Reports and exports
- Commerce APIs, events, hooks, and storefront blocks

### First-party companion plugins

- `justflows.payments`: managed Justflows payment onboarding and operations
- `justflows.payment-*`: bring-your-own payment gateway adapters
- `justflows.shipping-*`: carrier rates, labels, tracking, pickups, and returns
- `justflows.tax-*`: automated tax calculation and validation providers
- `justflows.shop-reviews`: ratings, reviews, verified ownership, and moderation
- `justflows.subscriptions`: recurring billing, trials, upgrades, and proration
- `justflows.bookings`: time- and capacity-based reservations
- `justflows.memberships`: protected content and commerce benefits
- `justflows.gift-cards`: gift cards and store credit
- `justflows.wholesale`: business accounts, approval, and price lists
- `justflows.point-of-sale`: in-person sales and stock synchronization
- `justflows.marketplace-vendors`: sellers, commissions, and payouts
- `justflows.product-feeds`: marketplace and advertising feeds
- `justflows.accounting`: bookkeeping and reconciliation integrations

Specialist modules must extend the same product, order, payment, tax, inventory,
and fulfillment contracts rather than creating parallel commerce systems.

## Conformance with the Justflows SDK, APIs, and hooks

Commerce is built through the existing Justflows extension model. It must not
introduce a second plugin runtime, event bus, route registry, permission model,
cache, logger, settings service, block registry, or job system.

### Stable SDK ownership

- Public extension contracts live in `@justflows/sdk`; commerce plugins never
  import runtime internals from `@justflows/core` or `apps/server`.
- `justflows.shop` publishes additive TypeScript types for products, carts,
  checkout, orders, payments, inventory, tax, shipping, fulfillments, returns,
  and money values.
- Companion plugins consume the Shop SDK/API contracts instead of reaching into
  Shop tables or importing private Shop modules.
- New public symbols, hook names, payloads, route shapes, provider interfaces,
  and manifest permissions are versioned API. Prefer additive evolution and a
  documented deprecation cycle.
- Plugin activation uses `PluginModule.activate(ctx)` and receives only scoped
  capabilities. Registrations are owned by the plugin and removed on
  deactivation.
- Admin navigation uses manifest `adminMenu` entries, the `admin.menu` filter
  on activate, and `admin:extend`; it does not patch the core sidebar directly.
  After first-run setup, `justflows.shop` contributes the commerce domain tabs
  (store overview, catalog, attributes, inventory, orders, customers, checkout,
  manual payments, shipping, tax, discounts, refunds, emails, reports). Nested
  paths skip the setup wizard. First-party companion plugins add their own
  `adminMenu` when installed.
- Storefront components register through `ctx.blocks` under the owning plugin's
  namespace.
- Cache access uses `ctx.cache`, with keys scoped by site, currency, locale,
  customer group, catalog version, and other inputs that change the result.
- Settings use `ctx.settings`; secrets use the platform's encrypted secret
  facility once exposed to plugins and are never stored in a manifest or plain
  plugin data.
- Outbound payment, carrier, tax, address, fraud, and notification calls require
  the `network:outbound` manifest permission.
- Background work requires `jobs:register`. Before Shop implementation begins,
  the plugin SDK must expose a scoped jobs facade because the permission exists
  today but `PluginContext` does not yet expose job registration or enqueueing.

### Required additive SDK work

The current plugin context is intentionally small. Shop must extend it through
reviewed, reusable platform contracts rather than bypassing it:

- A scoped commerce persistence API capable of transactions, migrations,
  compare-and-set/locking, pagination, and atomic inventory/order operations.
  The current `ctx.data` JSON-document API and its no-raw-SQL boundary remain
  appropriate for small plugin settings, but are not a transactional commerce
  database.
- A scoped jobs API for durable enqueueing, retries, schedules, uniqueness,
  cancellation, inspection, and dead-letter/recovery handling. In-process-only
  timers are insufficient for payment reconciliation and fulfillment work.
- A richer authenticated route API or deliberate core route integration. The
  current plugin HTTP facade supports only exact `GET` and `POST` public routes;
  it does not by itself provide resource parameters, `PATCH`/`DELETE`, user
  capabilities, CSRF policy, or OpenAPI registration.
- Additive commerce permissions for the narrow operations listed below.
- OpenAPI registration/composition so Shop and companion plugins can contribute
  schemas and paths without editing an unrelated static document.
- An encrypted secret API for provider credentials, signing keys, and optional
  external commerce database credentials.

These platform additions should be useful to other substantial plugins and
must retain permission scoping, lifecycle cleanup, structured logging, and
failure isolation.

### Hook semantics

Shop follows the canonical three Justflows hook kinds:

- **Actions** are emitted after a successful commit. They are read-only
  notifications; a failing listener is logged and must not roll back the
  commerce operation.
- **Gates** run before the transaction commits and may cancel with a human-readable
  reason. They fail closed. Use them for validation, policy, fraud holds, and
  permission-sensitive business rules.
- **Filters** transform a proposed value and must return the next value. Shop
  validates filtered output again before using it. Filters do not mutate shared
  event objects.

Hook payloads are minimal, serializable, read-only references. They carry IDs,
site ID, state, currency, and safe summaries where needed—not secrets, provider
credentials, raw requests, database handles, full payment data, or unnecessarily
duplicated personal data. `HookContext` supplies request/job/CLI/system source,
request correlation, site, and actor identity.

Commerce-owned hooks use the `justflows.shop.*` namespace because the current
runtime only permits a plugin to emit its own namespace. Their types are
published through declaration merging of `ActionEventMap`, `GateEventMap`, and
`FilterValueMap` in `@justflows/sdk`. Companion plugins publish their own hooks
under their own manifest IDs.

Suggested typed Shop hooks include:

| Kind | Hook | Purpose |
| --- | --- | --- |
| Gate | `justflows.shop.product.beforeCreate` | Validate or reject a proposed product |
| Gate | `justflows.shop.product.beforeUpdate` | Enforce product and catalog policy |
| Action | `justflows.shop.product.created` / `updated` / `deleted` | React after catalog changes commit |
| Gate | `justflows.shop.cart.beforeAddItem` | Validate item, variation, quantity, and eligibility |
| Action | `justflows.shop.cart.itemAdded` / `updated` / `removed` | Observe committed cart changes |
| Filter | `justflows.shop.cart.linePrice` | Adjust a typed proposed line price before totals |
| Filter | `justflows.shop.cart.fees` | Return typed proposed fees |
| Gate | `justflows.shop.checkout.beforeValidate` | Reject checkout on policy or fraud grounds |
| Gate | `justflows.shop.order.beforeCreate` | Final pre-commit order validation |
| Action | `justflows.shop.order.created` | Start safe post-commit work |
| Gate | `justflows.shop.order.beforeTransition` | Restrict a proposed order transition |
| Action | `justflows.shop.order.statusChanged` | React to a committed state transition |
| Filter | `justflows.shop.shipping.packages` | Transform proposed package grouping |
| Filter | `justflows.shop.shipping.rates` | Return validated shipping rate options |
| Filter | `justflows.shop.tax.lines` | Extend calculated tax lines through a typed contract |
| Gate | `justflows.shop.payment.beforeCapture` | Apply capture policy before provider interaction |
| Action | `justflows.shop.payment.authorized` / `captured` / `failed` | Observe recorded payment outcomes |
| Gate | `justflows.shop.refund.beforeCreate` | Validate amount, allocation, and permissions |
| Action | `justflows.shop.refund.created` / `completed` / `failed` | Observe refund lifecycle |
| Gate | `justflows.shop.fulfillment.beforeCreate` | Validate quantities and inventory location |
| Action | `justflows.shop.fulfillment.created` / `shipped` / `delivered` | Observe fulfillment progress |
| Gate | `justflows.shop.return.beforeCreate` | Validate return eligibility |
| Action | `justflows.shop.return.statusChanged` | Observe return progress |
| Action | `justflows.shop.inventory.adjusted` | React to a committed stock movement |
| Action | `justflows.shop.customer.created` / `updated` | Synchronize permitted customer data |

Names and payloads are finalized only when added to SDK types and hook
documentation. High-risk provider operations use explicit provider interfaces
and idempotent services; a generic filter must never be able to mark a payment
captured, fabricate an order transition, or mutate committed financial history.
Slow network calls and fan-out work run in jobs triggered by post-commit actions,
not inline on checkout or render hooks.

### Permission and capability model

Plugin manifest permissions control which platform APIs a commerce extension can
access. Signed-in user capabilities independently control what a person can do.
UI visibility is never the authorization boundary.

Add narrow user capabilities such as:

- `shop:settings`
- `products:read`, `products:create`, `products:update`, `products:delete`, and
  `products:publish`
- `inventory:read` and `inventory:adjust`
- `orders:read`, `orders:create`, and `orders:update`
- `payments:read`, `payments:capture`, and `payments:refund`
- `fulfillments:read` and `fulfillments:manage`
- `returns:read` and `returns:manage`
- `customers:read` and `customers:manage`
- `discounts:read` and `discounts:manage`
- `tax:read` and `tax:manage`
- `shop:reports`

Equivalent plugin permissions should expose only the scoped Shop API needed by
an extension. Reading orders must not automatically grant customer export,
capturing payment must not grant refunds, and product editing must not grant tax
or gateway configuration.

### HTTP and API conventions

- Public/headless Shop catalog reads live under a versioned `/api/v1/shop`
  surface and participate in the existing public API enablement, CORS, cache,
  preview, and rate-limit policies.
- Cart and checkout endpoints use a separately guarded Shop storefront surface.
  They follow the platform's boundary validation and rate-limit conventions but
  are controlled by Shop availability—not by the optional headless content API
  switch. Cross-origin checkout is denied by default and requires explicit
  storefront origin configuration.
- Administrative operations live under `/api/shop` (or a future consistently
  versioned admin prefix), require an installed site, a signed-in session, CSRF
  protection for cookie-authenticated mutations, and the narrowest capability.
- Customer account endpoints require the authenticated customer and enforce
  ownership server-side; accepting an order or customer ID is not authorization.
- Provider webhooks use dedicated unguessable/versioned routes, signature and
  timestamp verification, replay protection, raw-body handling where required,
  provider-specific rate limits, and idempotent event storage.
- Every request validates path parameters, query, headers, and bodies at the
  boundary. Responses never include secrets, raw database/provider errors,
  internal paths, or stack traces.
- Lists use bounded cursor pagination, deterministic ordering, filters, and
  explicit maximum page sizes.
- Mutations use idempotency keys where retries could duplicate an order,
  capture, refund, fulfillment, return, stock adjustment, or webhook effect.
- Errors use a stable JSON envelope with machine-readable code, human-readable
  message, request ID, and field details where safe.
- API resources use stable IDs, ISO 8601 UTC timestamps, explicit currencies,
  integer-minor-unit/decimal money strings, and immutable historical snapshots.
- Public product responses expose only published catalog data. Drafts, cost,
  private inventory details, customer information, internal notes, provider
  metadata, and fraud signals require appropriate authentication/capabilities.
- Shop publishes and tests an OpenAPI 3.1 document, including schemas, security,
  pagination, errors, idempotency, webhooks, and examples. The document is
  available alongside the current `/api/v1/openapi.json` contract or through a
  documented composed Shop endpoint.
- API changes follow semantic compatibility rules and include contract tests.

### Jobs and asynchronous processing

Use the Justflows jobs system, through the future scoped plugin facade, for:

- Payment reconciliation and missing-webhook recovery
- Expired cart and stock-reservation release
- Email, document, and signed webhook delivery
- Carrier tracking refresh and fulfillment reconciliation
- Tax-provider synchronization
- Import/export and WooCommerce migration batches
- Report aggregation
- Data retention and anonymization

Jobs carry site ID and correlation IDs, are idempotent, use bounded retries with
backoff, and expose failure/dead-letter state to administrators. A job must load
its current data by ID instead of trusting a stale serialized order or payment
object.

### Required developer documentation and examples

Before declaring the commerce SDK stable, publish:

- Shop SDK type and provider-interface reference
- Complete typed hook reference with timing and payloads
- Public, customer, admin, and webhook API/OpenAPI reference
- Permission/capability matrix
- Example payment, shipping, tax, promotion, and product-type plugins
- Lifecycle, cleanup, cache invalidation, jobs, idempotency, and migration guides
- Compatibility and deprecation policy
- Test harnesses and contract suites that third-party adapters can run

## 1. Store setup and configuration

- Store identity, legal name, business address, and contact information
- Selling countries, shipping countries, and excluded regions
- Base currency, formatting, decimal precision, and rounding behavior
- Weight and dimension units
- Tax-inclusive or tax-exclusive catalog configuration
- Guest checkout and customer account policies
- Configurable checkout fields
- Terms, privacy, shipping, cancellation, and refund policy pages
- Order-number prefix, suffix, and sequence rules
- Inventory reservation duration
- Notification sender and staff recipients
- Store modes: open, paused, catalog-only, and maintenance
- Minimum and maximum order values
- Test/sandbox mode with an unmistakable admin and storefront indicator
- Commerce database mode selected during Shop setup:
  - Use the current Justflows database (default)
  - Use a separately configured commerce database to isolate storage and load
- Connection test, dialect detection/confirmation, TLS status, migration status,
  and health diagnostics before enabling checkout
- Automatic creation and validation of required pages (Shop `activate()`
  creates the `product` and `shop` content types, then publishes these pages
  of type `shop` when they are missing; existing slugs are left unchanged):
  - Shop
  - Product
  - Product category
  - Cart
  - Checkout
  - Order confirmation
  - Customer account
  - Order tracking
- Configuration health checks for payment, tax, shipping, email, and webhooks
- Import/export of non-secret store configuration

## 2. Commerce data model

### Database topology

The merchant chooses one of two supported storage topologies per site:

1. **Current Justflows database:** Shop tables use the application's existing
   database connection and dialect. This is the simplest default and keeps
   backup and operation requirements small.
2. **Separate commerce database:** Shop uses a dedicated PostgreSQL, MySQL, or
   MariaDB database and connection pool. This separates commerce queries,
   storage growth, and connection load from content/admin traffic.

The choice is configured through the browser-first Shop setup UI and can also
be supplied by environment variables for managed deployments
(`JUSTFLOWS_SHOP_DB_DRIVER`, `HOST`, `PORT`, `NAME`, `USER`, `PASSWORD`, `SSL`,
and `SSL_REJECT_UNAUTHORIZED`). When those are set, topology is separate and
the connection fields are read-only. Database names, hosts, ports, TLS mode, and
non-secret status may be shown to administrators; passwords and connection URLs
are encrypted or environment-backed, write-only, redacted, and never returned by
an API or included in diagnostics.

Both modes use the same Shop repository/service interfaces and pass the same
dialect contract tests. No domain service may branch on storage topology beyond
connection/bootstrap infrastructure. The separate commerce database may use a
different supported dialect from the main Justflows database.

Separate-database requirements:

- Dedicated least-privilege database user and bounded connection pool
- TLS configuration and certificate verification controls suitable for the host
- Independent, ordered Shop migration history and migration lock
- Install/update preflight and clear failure without partially enabling Shop
- Readiness and liveness checks for both core and commerce databases
- Independent backup/restore documentation and compatibility metadata
- Metrics for connection use, latency, errors, and pool saturation without
  logging credentials or customer data
- No cross-database SQL joins, foreign keys, or distributed transaction claims
- Globally stable site, user, media, and content identifiers stored as references
- Transactional outbox/inbox and idempotent jobs for work crossing the core and
  commerce database boundary
- Defined behavior when content is available but commerce storage is unavailable:
  public catalog may use a safe cache if valid, but cart, checkout, payment,
  stock, and order mutations fail closed

Changing topology after launch is a migration workflow, not a settings toggle.
It requires maintenance mode, destination validation, consistent export/copy,
row counts and integrity verification, cutover, cache invalidation, rollback
instructions, and an audit record. Shop must never silently point an existing
store at an empty database.

The main Justflows database retains the plugin installation/activation state and
a non-secret site-to-commerce-storage binding. The selected Shop database is the
system of record for transactional commerce entities. Media/content references
remain IDs across the boundary. Operations spanning both databases use explicit
eventual-consistency and reconciliation rules rather than pretending to be one
atomic transaction.

Use dedicated transactional tables or equivalent strongly defined persistence
for:

- Products and localized product content
- Product types, attributes, options, and variations
- Product media relationships
- Prices, price lists, and scheduled prices
- Inventory locations, quantities, reservations, and stock movements
- Customers, customer groups, and addresses
- Carts and cart items
- Orders and immutable order-line snapshots
- Payment intents, attempts, captures, voids, and provider events
- Refunds and refund allocations
- Fulfillments, packages, shipments, and tracking events
- Returns and return items
- Tax classes, rules, registrations, exemptions, and calculated tax lines
- Coupons, promotions, gift cards, and store credit
- Digital download files and permissions
- Internal notes, customer notes, events, and audit records

Historical orders must retain product, address, price, discount, tax, and
shipping snapshots even when the source product or configuration later changes.
Money uses integer minor units or a decimal representation with explicit
currency and precision; never binary floating-point arithmetic.

## 3. Products and catalog

### Product types

- Simple physical product
- Variable product
- Digital/downloadable product
- Virtual product or service
- Grouped product
- Bundle or kit
- External/affiliate product
- Gift card
- Extension product types for subscriptions, bookings, rentals, memberships,
  pre-orders, and made-to-order goods

### Product content and presentation

- Title, slug, full description, and short description
- Visual block-based product description
- Featured image, gallery, and product video
- Product-specific SEO, social metadata, and structured data
- Product template selection and theme overrides
- Categories, brands, collections, tags, and custom taxonomies
- Related products, upsells, cross-sells, and frequently bought together
- Product badges and merchandising labels
- Custom tabs and specification tables
- Visibility: public, hidden, catalog-only, search-only, password-protected,
  scheduled, and customer-group restricted
- Lifecycle: draft, scheduled, active, archived, and discontinued
- Localized content, slugs, attributes, and SEO
- Product revisions and restoration
- Duplicate product
- Bulk editing
- CSV import/export with validation and dry-run reporting
- Product comparison
- Wishlists
- Recently viewed products
- Search, sorting, layered filters, pagination, and canonical URLs
- Search indexing and cache invalidation after catalog changes

### Product identifiers and physical data

- Unique product and variation SKU
- Barcode and GTIN/EAN/UPC/ISBN fields
- Manufacturer part number
- Weight and dimensions
- Shipping class
- Country of origin
- Customs/commodity code
- Cost of goods
- Supplier reference

## 4. Attributes, variations, and product configuration

- Global reusable attributes
- Product-specific attributes
- Text, number, color, image, button, select, and swatch presentation
- Attribute option labels, values, ordering, and localization
- Default selections
- Automatically generate valid variation combinations
- Rules for invalid or unavailable combinations
- Lazy/configurator-driven combinations when a Cartesian product is too large
- Enable or disable individual variations
- Variation-specific:
  - SKU and barcode
  - Regular, sale, and cost price
  - Sale schedule
  - Stock and backorder policy
  - Weight, dimensions, and shipping class
  - Images and media
  - Tax class
  - Download files, limits, and expiry
  - Availability dates
  - Minimum, maximum, and quantity increment
- Product- and variation-level inventory sharing
- Bulk variation creation, editing, activation, and deletion
- Product add-ons such as engraving, custom text, file upload, gift wrapping,
  personalization, and paid options
- Accessible variation selection and unavailable-combination feedback

## 5. Pricing and price lists

- Regular and sale price
- Scheduled sale start and end
- "From" prices for variable products
- Catalog and checkout tax display settings
- Cost of goods and gross-margin reporting
- Suggested retail price
- Customer-group and wholesale pricing
- Quantity and tier pricing
- Price lists by country, currency, customer group, site, or sales channel
- Fixed localized prices as an alternative to exchange-rate conversion
- Currency conversion adapter and cached rates
- Minimum advertised price support
- Configurable rounding rules
- Dynamic-pricing extension hooks
- Price history and audit trail
- Repricing before checkout to reject stale or manipulated cart totals

## 6. Inventory

- Global inventory enablement and display policy
- Product- and variation-level quantities
- Multiple inventory locations
- Available, reserved, committed, incoming, damaged, and unavailable quantities
- Atomic stock reservation during checkout
- Reservation expiry and release
- Backorders: disabled, allowed, or allowed with customer notice
- Pre-orders and availability dates
- Low-stock and out-of-stock thresholds and notifications
- Hide or display out-of-stock products and variations
- "Only X left" presentation policy
- Sold-individually products
- Purchase minimums, maximums, and increments
- Stock movement ledger with actor, reason, and source document
- Manual stock adjustments
- Inventory import/export
- Overselling protection during concurrent checkout
- Configurable restocking on cancellation, return, or refund
- Inventory transfer between locations
- Stock counts and reconciliation
- Future supplier and purchase-order module

## 7. Cart

- Persistent guest and authenticated carts
- Secure, opaque cart identifiers
- Guest cart merge after login
- Product and variation validation
- Quantity changes and removal
- Coupon, gift-card, and store-credit application
- Shipping and tax estimation
- Saved and shared carts
- Abandoned-cart lifecycle and consent-aware recovery hooks
- Cart expiration
- Cross-sells and recommendations
- Gift messages and gift wrapping
- Cart and line-item custom metadata
- Minimum/maximum quantity enforcement
- Single-currency consistency
- Server-side repricing before checkout
- Unavailable stock and discontinued-product recovery
- Extension hooks for lines, fees, discounts, validations, and presentation

## 8. Checkout

- Guest checkout
- Login and account creation during checkout
- Billing and shipping addresses
- International, configurable address formats
- Configurable checkout fields
- Company and tax identification fields
- Shipping method selection
- Payment method selection
- Coupons, gift cards, and store credit
- Order notes
- Required terms/privacy consent
- Separate optional marketing consent
- Address validation adapter
- Tax and shipping recalculation when relevant inputs change
- Idempotent order creation
- Duplicate-payment prevention
- Strong Customer Authentication support through gateways
- Express checkout adapters
- Accessible validation, focus management, and failure recovery
- Server-side total verification
- Asynchronous and redirect payment completion
- Recovery when payment succeeds but the browser never returns

## 9. Orders

### Default state model

- Draft
- Pending payment
- Payment authorized
- Paid
- Processing
- Partially fulfilled
- Fulfilled/completed
- On hold
- Cancellation requested
- Cancelled
- Partially refunded
- Refunded
- Failed
- Disputed
- Archived

The order state machine must define valid transitions, the capabilities required
for manual transitions, and the external events allowed to trigger them.

### Order administration

- Search, filter, sort, and paginate orders
- Order timeline and immutable audit history
- Private staff notes and customer-visible notes
- Edit addresses with history
- Add or remove lines before fulfillment under a safe recalculation policy
- Manual orders
- Draft orders and payment links
- Recalculate totals
- Authorize and capture payment
- Partial capture where supported
- Void/cancel authorization
- Full and partial refunds
- Optional restock during refund
- Resend notifications and documents
- Invoices, credit notes, and packing slips
- Duplicate and reorder
- Fraud-risk information and review holds
- CSV export and bulk operations
- Order tags
- Personal-data retention, export, and anonymization
- Never hard-delete financially relevant orders

## 10. Payments

### Payment gateway contract

All payment adapters must support declared capabilities rather than pretending
every provider implements the same operations:

- Create payment or payment intent
- Confirm or redirect
- Authorize
- Capture fully or partially
- Void/cancel authorization
- Refund fully or partially
- Parse and verify signed webhooks
- Query/reconcile remote state
- Tokenize/save a payment method through the provider
- Describe asynchronous/pending payment state
- Report disputes, chargebacks, and provider fees when available
- Separate sandbox and production configuration
- Idempotency and replay protection

### Bring-your-own payment credentials

Candidate first-party adapters include:

- Stripe
- PayPal
- Mollie
- Adyen
- Square
- Bank transfer
- Cash on delivery
- Check/manual payment

Requirements:

- Secrets encrypted at rest and never returned through APIs
- Merchant-owned provider account and credentials
- Separate sandbox and live credentials
- Verified webhooks and diagnostics
- Payment-attempt history
- Authorization, capture, void, cancellation, and refund actions
- Asynchronous payment methods
- Failed-payment recovery
- Provider tokens only; never store raw card data
- Dispute and chargeback visibility
- Payout and reconciliation metadata where available

### Justflows Payments

`justflows.payments` provides a managed alternative over the same gateway
contract:

- Connect or create a merchant account
- KYC/onboarding and account requirement state
- Provider capabilities by country and payment method
- Managed webhook delivery
- Unified payment and payout reporting
- Managed captures, cancellations, and refunds
- Dispute management
- Account restriction and remediation state
- Explicit platform, processing, and merchant fees
- Clear terms and merchant ownership boundaries
- Ability to switch to bring-your-own providers without rewriting Shop data

## 11. Shipping configuration

- One or more shipping origins
- Ordered shipping zones by continent, country, state/province, city, and postal
  code
- Exact postal codes, ranges, and wildcards
- Most-specific-first matching and a rest-of-world fallback
- Excluded destinations and zones with no available shipping
- Shipping classes
- Product/package weight and dimensions
- Handling fees
- Free-shipping thresholds
- Local pickup
- Local delivery
- Flat rate
- Table rate
- Weight-based rate
- Price-based rate
- Item-count rate
- Carrier-calculated rates
- Delivery-date estimates
- Restricted destinations and PO box rules
- Hazardous and oversized rules
- Multi-package and split-shipment calculation
- Customer-facing reason when no shipping method is available

## 12. Fulfillment and carrier integrations

A fulfillment/shipment is separate from an order because an order can be
fulfilled in multiple packages, at different times, and from different
locations.

- Create one or more fulfillments
- Select fulfilled quantities
- Fulfill from a chosen inventory location
- Create packages with weight and dimensions
- Tracking carrier, number, URL, and events
- States: prepared, label created, shipped, in transit, delivered, delayed,
  lost, returned, and cancelled
- Cancel fulfillment before carrier acceptance
- Void a shipping label
- Reprint labels and packing slips
- Partial, split, and merged shipments
- Delivery confirmation
- Customer shipment notifications
- Carrier webhook ingestion and reconciliation
- Customs declarations and documents
- Pickup scheduling
- Fulfillment notes and audit history

Candidate carrier/aggregator adapters include DHL, UPS, FedEx, USPS, PostNL,
DPD, GLS, Sendcloud, and Shippo. Each adapter declares support for live rates,
address validation, labels, voids, customs, pickup, tracking, and return labels.

## 13. Returns, exchanges, cancellations, and refunds

- Merchant- and customer-initiated cancellation requests
- Cancellation eligibility and approval rules
- Release reserved stock and void uncaptured payment on cancellation
- Return Merchandise Authorization number
- Customer return request
- Configurable return window
- Return reasons
- Partial quantities
- Photo and file evidence
- Approve or reject
- Return shipping responsibility
- Return label generation
- Return states:
  - Requested
  - Approved
  - Rejected
  - Label created
  - In transit
  - Received
  - Inspected
  - Resolved
  - Cancelled
- Restock immediately, on receipt, after inspection, or never
- Item condition: resellable, open box, damaged, or dispose
- Resolution: refund, partial refund, exchange, replacement, repair, or store
  credit
- Restocking and return fees
- Original shipping refund policy
- Exchange price differences
- Full and partial payment refunds
- Manual versus provider-processed refunds
- Customer and staff notifications
- Refund, return, inventory, tax, and payment audit linkage

## 14. Configurable VAT, sales tax, and GST

Core supplies calculation tools, not legal advice. Merchants remain responsible
for determining where they must register, collect, report, or exempt tax.

### Generic tax engine

- Enable or disable tax
- Prices entered inclusive or exclusive of tax
- Independent shop and checkout tax display
- Configurable labels such as VAT, GST, or sales tax
- Tax classes
- Multiple rates per class
- Compound taxes
- Inclusive and exclusive calculations
- Shipping and fee taxation
- Discount application before or after tax
- Per-line or per-subtotal rounding
- Explicit precision
- Tax address basis: store, billing, or shipping
- Rules by country, state/province, city, postal code, customer group, product
  class, site, and sales channel
- Effective start and end dates
- Rule priority and compound order
- Customer and product exemptions
- Exemption certificate metadata
- Business tax identifiers
- Reverse-charge workflow flags
- Digital-product customer-location evidence fields
- Immutable tax snapshots on orders and refunds
- Manual rate import/export
- Tax reports by jurisdiction, class, and rate
- Explainable calculation trace for each order
- Hooks for validation, exemption, and calculation providers

### Automated tax adapters

Potential providers include Stripe Tax, Avalara, TaxJar, Quaderno, regional VAT
ID validation services, and future regional providers. Adapters may calculate,
validate, report, or file, but their presence must not be represented as a legal
compliance guarantee.

## 15. Discounts, coupons, promotions, and credit

- Coupon codes
- Automatic promotions
- Fixed-cart discount
- Fixed-product discount
- Percentage discount
- Buy X get Y
- Quantity and tier discounts
- Free shipping
- Product, category, brand, customer, and region restrictions
- Minimum and maximum spend
- Global and per-customer usage limits
- First-order-only promotions
- Scheduled activation and expiry
- Email/domain restrictions
- Coupon stacking, priority, and exclusivity
- Gift cards
- Store credit
- Promotion preview and explanation
- Correct discount allocation across lines, shipping, tax, refunds, and reports
- Extension contract for custom eligibility and benefit rules

## 16. Customer accounts

- Order history and order details
- Payment status
- Fulfillment and shipment tracking
- Cancellation and return requests
- Reorder
- Saved billing and shipping addresses
- Provider-tokenized saved payment methods
- Downloadable purchases
- Download limits and expiry
- Wishlists
- Communication preferences and consent history
- Company and tax information
- Personal-data export and account deletion/anonymization request
- Platform password, federated login, MFA, and session controls
- Customer groups
- Wholesale/business account approval
- Gift-card and store-credit balances

## 17. Digital products

- One or more files per product or variation
- Protected storage and authorized download endpoint
- Expiring signed download links
- Download limits
- Download expiry
- Permission grants tied to paid order lines
- Revoke and reissue permission
- Updated-file policy for existing buyers
- Digital-only orders skip physical fulfillment
- Optional license-key provider interface
- Download audit history without exposing storage paths

## 18. Notifications and documents

- New order
- Order received
- Payment authorized, succeeded, pending, or failed
- Cancellation requested and completed
- Refund issued
- Fulfillment created
- Shipment and tracking updates
- Delivered
- Return status updates
- Low- and out-of-stock staff alerts
- Dispute and chargeback alerts
- Invoice
- Credit note
- Packing slip
- Refund document
- Configurable, localized templates
- Customer and staff recipient policies
- Resend controls and delivery history
- Email, webhook, and extension notification channels
- SMS and messaging adapters

## 19. Reporting and reconciliation

- Gross and net sales
- Tax
- Shipping
- Discounts
- Refunds
- Payment and platform fees
- Cost of goods and gross margin
- Order count and average order value
- Product, variation, category, and brand performance
- Customer acquisition and repeat purchases
- Inventory valuation
- Low stock, out of stock, and dead stock
- Fulfillment time and delivery performance
- Return rate and reasons
- Tax by jurisdiction, class, and rate
- Payment captures, refunds, disputes, payouts, and reconciliation
- Date, site, channel, currency, customer group, and status filters
- CSV export
- Analytics plugin integration without mixing operational order data into
  page-view storage
- Scheduled reconciliation of local payment state with provider state

## 20. Storefront, admin, and design

### Storefront blocks

- Product grid/list
- Featured products
- Product detail
- Product gallery
- Price
- Stock/availability
- Variation selector
- Add to cart
- Mini-cart
- Cart
- Checkout
- Product search
- Category, collection, and brand navigation
- Layered filters
- Product comparison
- Wishlist
- Reviews and rating summary
- Related products and recommendations
- Customer account and order history
- Order tracking

### Admin areas

- Shop dashboard
- Products, categories, brands, attributes, and variations
- Inventory and stock movements
- Orders and draft orders
- Payments, refunds, disputes, and reconciliation
- Fulfillments, shipments, and returns
- Customers and customer groups
- Discounts and gift cards
- Tax configuration and reports
- Shipping zones, methods, carriers, and labels
- Reports
- Shop settings and health
- Provider connection and diagnostics
- Capability-scoped staff access

Themes control presentation without owning commerce state or calculations. Shop
provides accessible defaults so activation does not require a special theme.

## 21. APIs, SDK, webhooks, and extensions

- Versioned `/api/v1/shop` public catalog API under the public API guard, CORS,
  cache, and rate-limit policies
- Authenticated customer commerce API with resource ownership checks
- Capability-protected `/api/shop` administrative API with CSRF protection
- Separately guarded and rate-limited cart/checkout API that remains available
  when the Shop is open even if the optional headless content API is disabled
- Payment gateway SDK
- Shipping method and carrier SDK
- Tax provider SDK
- Promotion and pricing extension points
- Fulfillment provider SDK
- Product-type extension SDK
- Import/export contracts
- Signed commerce webhooks
- Idempotency keys for mutation APIs
- Rate limiting and abuse controls
- OpenAPI 3.1 schemas and composition/registration contract
- Stable error envelope and cursor-pagination contract
- Stable public types and compatibility policy
- Plugin-owned migrations and data boundaries
- Scoped jobs facade for email, webhooks, fulfillment, expiry, imports, and
  reconciliation
- Headless storefront support
- Events for product, cart, checkout, order, payment, refund, shipment, return,
  customer, tax, and inventory state changes

## 22. Security, privacy, and reliability

- Recalculate and validate all totals on the server
- Never trust client-provided price, discount, tax, shipping, stock, or payment
  state
- Atomic order and inventory transitions
- Idempotent checkout, payment, capture, refund, and webhook operations
- Signed webhooks with timestamp and replay protection
- Encrypted provider secrets
- Least-privilege capabilities for products, orders, refunds, fulfillment, tax,
  reporting, customers, and configuration
- Complete audit log for financially relevant changes
- Fraud-provider hooks and manual review holds
- Checkout, login, coupon, download, and account rate limiting
- Data retention, export, and anonymization
- Payment-data isolation and no raw card storage
- Secure digital downloads
- Concurrency tests for scarce stock and coupon limits
- Recovery when payment succeeds but local processing fails
- Reconciliation for missing or duplicated provider events
- Archive/anonymize instead of deleting orders
- Backup and restore compatibility
- Multi-site data isolation
- Currency and decimal correctness tests
- PostgreSQL, MySQL, and MariaDB migration compatibility
- Observability without logging secrets, full addresses, or payment data

## 23. Reviews and merchandising

- Product ratings and reviews
- Verified-purchase indicator
- Review moderation and spam controls
- Rating aggregates
- Review media with safe upload handling
- Merchant replies
- Review import/export
- Featured products
- Collections and campaigns
- Related, upsell, and cross-sell rules
- Recently viewed products
- Wishlists
- Product comparison
- Recommendation-provider hook
- Search synonyms, boosts, and merchandising rules

## 24. Import, export, and migration

- Product, variation, attribute, customer, order, coupon, and inventory CSV
  import/export
- Dry-run validation with row-level errors
- Resumable large imports through jobs
- Media import with safe URL fetching and limits
- WooCommerce migration:
  - Products and variations
  - Categories, tags, attributes, and media
  - Customers and addresses
  - Orders and order notes
  - Coupons
  - Reviews
  - Tax and shipping configuration where mappings are unambiguous
  - Explicit unsupported-extension report
- Portable Justflows Shop export/restore
- Stable external identifiers for repeatable imports
- Duplicate detection and idempotent reruns

## 25. Future specialist modules

These modules should build on Shop contracts and should not block a complete
first Shop release:

### Subscriptions

- Recurring payment schedules
- Trials and signup fees
- Upgrade, downgrade, and proration
- Pause, resume, cancel, and reactivate
- Failed-payment retry and dunning
- Subscription customer portal
- Renewal orders and invoices

### Bookings and rentals

- Availability calendars
- Capacity and resources
- Time zones
- Buffers and lead times
- Deposits
- Reschedule and cancellation rules
- Rental handoff/return and damage state

### Memberships

- Plans and access grants
- Protected content/products
- Commerce discounts and benefits
- Expiry and renewal

### Wholesale and B2B

- Business account approval
- Customer-specific catalogs and price lists
- Minimum quantities and case packs
- Purchase orders and payment terms
- Tax exemption documents
- Quotes and negotiated orders

### Multi-vendor marketplace

- Vendor onboarding and capabilities
- Vendor-owned products and fulfillment
- Commission calculation
- Split payments and payouts
- Vendor returns and disputes
- Marketplace reporting and moderation

### Point of sale

- In-person cart and checkout
- Register and cash management
- Receipts
- Barcode workflows
- Offline/recovery strategy
- Shared inventory synchronization

## Delivery epics

Convert this roadmap into scoped issues under these epics:

1. Shop foundation and transactional data model
2. Commerce SDK, typed hooks, permissions, jobs, and OpenAPI foundations
3. Shared and separate commerce database topology
4. Product catalog and storefront design
5. Attributes, variations, and advanced product configuration
6. Pricing and price lists
7. Inventory and reservations
8. Cart
9. Checkout
10. Order lifecycle and administration
11. Payment gateway SDK and bring-your-own providers
12. Justflows Payments
13. Shipping zones, rates, and fulfillment
14. Carrier adapters, labels, and tracking
15. Returns, exchanges, cancellations, and refunds
16. Generic VAT/GST/sales-tax engine
17. Automated tax adapters
18. Discounts, coupons, gift cards, and promotions
19. Customer accounts and digital delivery
20. Notifications, invoices, and documents
21. Commerce reporting and reconciliation
22. Storefront/admin APIs, webhooks, and extension SDK
23. Security, privacy, audit, and recovery
24. Reviews, search, and merchandising
25. Import/export and WooCommerce migration
26. Subscription, booking, membership, B2B, marketplace, and POS modules

Each implementation issue should state its owning plugin/package, supported
database dialects, public SDK impact, admin and storefront surfaces, security
requirements, migration plan, tests, documentation, and explicit done criteria.

## First complete release boundary

The first release called a complete Shop should include:

- Simple, variable, virtual, and downloadable products
- Product categories, attributes, variations, media, SEO, and theme blocks
- Pricing, sale schedules, SKU, stock, reservations, and backorders
- Cart and accessible checkout
- Guest and account checkout
- Orders, staff notes, email notifications, and customer order history
- Manual payment plus at least one bring-your-own online gateway
- Full and partial capture/refund where the chosen gateway supports them
- Flat rate, free shipping, local pickup, zones, and basic fulfillment/tracking
- Configurable generic tax classes and geographic rates
- Coupons
- Digital delivery
- Core reports and CSV export
- APIs, signed webhooks, audit logging, and reconciliation
- Typed Shop SDK contracts, documented gates/actions/filters, scoped jobs, and
  OpenAPI 3.1 coverage
- Merchant choice between the current Justflows database and a separately
  configured commerce database, with tested migration, health, backup, and
  failure behavior
- PostgreSQL, MySQL, and MariaDB support
- Secure, idempotent, concurrency-tested transactional behavior

Subscriptions, bookings, carrier-label purchasing, automated tax filing,
multi-vendor marketplaces, POS, and Justflows Payments can follow as modules.
They must not be required for a merchant to run a normal self-hosted shop with
their own provider credentials.
