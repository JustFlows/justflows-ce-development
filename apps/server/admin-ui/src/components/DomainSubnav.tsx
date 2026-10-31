import { NavLink } from "../admin-router";
import { useT } from "../i18n/I18nProvider";
import { navLabel, type NavDomain } from "../config/admin-nav";

type Props = {
  domain: NavDomain;
};

export default function DomainSubnav({ domain }: Props) {
  const { t, locale } = useT();

  return (
    <nav className="jf-domainnav" aria-label={navLabel(t, domain, locale)}>
      {domain.items.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.end} className="jf-domainnav__link">
          <span className="jf-domainnav__icon" aria-hidden="true">{item.icon}</span>
          {navLabel(t, item, locale)}
        </NavLink>
      ))}
    </nav>
  );
}
