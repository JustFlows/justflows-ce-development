# 07 — Marketplace Developer Agreement

**Applies to:** Developers and publishers who distribute plugins, themes, or
extensions through the official **Justflows Marketplace**.

**Version:** 1.1

**Operator:** Justflows Contributors

By submitting a listing, you agree to these terms.

---

## 1. Purpose

The Justflows Marketplace is a **curated, signed distribution channel** for
plugins and themes. It provides:

- Security review and approval
- Package signing and verified updates
- Discovery and installation for self-hosted and cloud users
- Payment processing for paid listings (Justflows Payments)

The Marketplace is **optional**. Self-hosted users may sideload extensions
outside the Marketplace (see [03-plugins.md](./03-plugins.md)).

---

## 2. Eligibility

To list in the Marketplace you must:

1. Have legal authority to distribute the software
2. Accurately declare a **GPL-compatible license**, or a closed `LicenseRef-` license covered by a contract, for Marketplace listings (see [03-plugins.md](./03-plugins.md))
3. Provide valid contact and publisher information
4. Pass security review before first publication and on material updates
5. Accept this agreement

---

## 3. Security review & approval

Justflows reviews every listing **before publication** and may re-review updates.

| Review area       | Examples                                                           |
| ----------------- | ------------------------------------------------------------------ |
| **Permissions**   | Requested permissions match functionality                          |
| **Code safety**   | No eval injection, no credential harvesting, no obfuscated malware |
| **Dependencies**  | Known-vulnerable dependencies flagged or rejected                  |
| **Data handling** | Privacy policy if collecting personal data                         |
| **Quality**       | Basic functionality works as described                             |

Justflows may **approve**, **request changes**, or **reject** listings.
Decisions are at Justflows' reasonable discretion.

---

## 4. Package signing

Approved packages are **signed** by Justflows. Only signed packages are
installable from the Marketplace without extra admin warnings.

You must not:

- Distribute forged signatures
- Circumvent signing verification
- Publish unsigned updates through the official channel

---

## 5. Licensing in the Marketplace

Justflows **core is MIT**. Plugins and themes keep **their own license**.
Official Marketplace listings use a **GPL-compatible license**. Plugins and themes,
free or paid, may use a closed license under a separate closed-source contract
with Justflows. The full terms are in the
[Publisher Agreement](https://partners.justflows.com/publisher-agreement).

| Listing type                    | Requirement                                                |
| ------------------------------- | ---------------------------------------------------------- |
| **GPL-2.0-or-later**            | Common for extensions — include SPDX identifier and source |
| **GPL-3.0-or-later**            | Allowed                                                    |
| **MIT / other GPL-compatible**  | Allowed                                                    |
| **Closed source** (`LicenseRef-<name>`) | Plugins and themes, free or paid, under a closed-source contract only; source always available to Justflows reviewers |

### Paid listings (allowed)

You may charge for plugins and themes. Payment is for access, updates, and
support. Recipients must be able to exercise the rights of the **declared
extension license** (for GPL listings, that includes GPL source rights).

Marketplace listing adds **distribution, security, and payment requirements**
on top of the declared license — it does not replace them.

---

## 6. Payments — Justflows Payments

### Paid listings

If you charge for your plugin or theme in the Marketplace:

1. **You must use Justflows Payments** for all Marketplace transactions
2. You may not link to external checkout to bypass Marketplace fees
3. Pricing must be clearly displayed before purchase
4. Refund policy must be stated in your listing

### Revenue share

Justflows retains a **5% platform fee** on Marketplace sales.

### Payouts

Payouts are processed according to Justflows Payments terms (minimum threshold,
schedule, tax documentation as required by law).

### Free listings

Free open-source and free proprietary listings do not require payment processing.

---

## 7. Updates & compatibility

You must:

- Maintain compatibility with supported Justflows versions declared in manifest
- Publish security fixes in a timely manner for critical vulnerabilities
- Not introduce breaking changes without a major version bump

Justflows may hide or delist listings that are incompatible with current supported releases.

---

## 8. Prohibited content

Listings must not:

- Violate applicable law
- Infringe third-party intellectual property
- Contain malware, spyware, or unauthorized cryptomining
- Misrepresent affiliation with Justflows
- Bypass core security or permission systems
- Collect user data without disclosure and lawful basis

---

## 9. Revocation & delisting

Justflows may suspend or remove listings that:

- Fail security review
- Violate this agreement
- Receive substantiated abuse reports
- Remain incompatible or unmaintained (after notice period)

Delisting does not automatically remove sideloaded copies on user sites.

---

## 10. Support obligations

| Responsibility       | Owner                            |
| -------------------- | -------------------------------- |
| Extension support    | Publisher                        |
| Marketplace platform | Justflows                        |
| Core platform        | Justflows (official builds only) |

Publishers of paid listings should provide a support contact and reasonable response expectations.

---

## 11. Trademark

You may not use Justflows trademarks to imply official endorsement unless
participating in an authorised partner programme.

See: [08-trademark-support-warranty.md](./08-trademark-support-warranty.md)

---

## 12. Indemnification

You agree to indemnify Justflows against claims arising from your listing,
including intellectual property infringement and harm caused by your extension,
except where caused by Justflows' gross negligence.

---

## 13. Changes to this agreement

Justflows may update this agreement with notice to publishers. Continued
distribution after notice constitutes acceptance, or you may withdraw listings.

---

## 14. Contact

- Marketplace submissions: `marketplace@justflows.com`
- Security reports: `security@justflows.com`
- Legal: `legal@justflows.com`

---

## Related documents

- [03-plugins.md](./03-plugins.md)
- [04-themes.md](./04-themes.md)
- [06-enterprise-license.md](./06-enterprise-license.md)
