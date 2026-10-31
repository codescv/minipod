/**
 * Top Charts sub-view shown inside `AddSearch` when the unified input is empty (`DESIGN.md` §4.2).
 */
import { useEffect, useState } from 'react';
import type { CountryCode, SearchResult } from '@minipod/core';
import { ArtworkImage, Icon, shouldUseImageProxy } from '../../components/m3';
import { useHost } from '../../host/HostContext';
import { useT } from '../../i18n';
import { useSettingsStore } from '../../stores/settings';
import { getHostViewCache } from '../../stores/view-cache';

export function TopCharts({
  onSelectResult,
}: {
  readonly onSelectResult: (result: SearchResult) => void;
}) {
  const host = useHost();
  const t = useT();

  const country = useSettingsStore((s) => s.settings.topChartsCountry);
  const updateSettings = useSettingsStore((s) => s.update);

  const [countries, setCountries] = useState<
    readonly { readonly code: CountryCode; readonly name: string }[]
  >(() => getHostViewCache(host).topChartsCountries);
  const [charts, setCharts] = useState<readonly SearchResult[]>(
    () => getHostViewCache(host).topChartsByCountry.get(country) ?? [],
  );
  const [loading, setLoading] = useState(
    () => !getHostViewCache(host).topChartsByCountry.has(country),
  );

  useEffect(() => {
    let alive = true;
    void host.search.countries().then((list) => {
      getHostViewCache(host).topChartsCountries = list;
      if (alive) setCountries(list);
    });
    return () => {
      alive = false;
    };
  }, [host]);

  useEffect(() => {
    const viewCache = getHostViewCache(host);
    const cached = viewCache.topChartsByCountry.get(country);
    if (cached !== undefined) {
      setCharts(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }
    const ctrl = new AbortController();
    void host.search
      .topCharts(country, ctrl.signal)
      .then((items) => {
        if (!ctrl.signal.aborted) {
          getHostViewCache(host).topChartsByCountry.set(country, items);
          setCharts(items);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!ctrl.signal.aborted) {
          if (!getHostViewCache(host).topChartsByCountry.has(country)) {
            setCharts([]);
          }
          setLoading(false);
        }
      });
    return () => ctrl.abort();
  }, [country, host]);

  const handleCountryChange = (next: CountryCode) => {
    const cached = getHostViewCache(host).topChartsByCountry.get(next);
    if (cached !== undefined) {
      setCharts(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }
    void updateSettings(host, { topChartsCountry: next });
  };

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="top-charts-section">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <h2 style={{ margin: 0, font: 'var(--md-sys-typescale-title-medium)' }}>{t('add.topCharts')}</h2>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span style={{ font: 'var(--md-sys-typescale-label-medium)', color: 'var(--md-sys-color-on-surface-variant)' }}>
            {t('add.country')}
          </span>
          <select
            className="m-field__input"
            style={{ minHeight: 36, padding: '4px 10px' }}
            aria-label={t('add.country')}
            data-testid="top-charts-country-select"
            value={country}
            onChange={(e) => handleCountryChange(e.target.value)}
          >
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {loading && charts.length === 0 ? (
        <div className="m-empty">{t('common.loading')}</div>
      ) : !loading && charts.length === 0 ? (
        <div className="m-empty" data-testid="top-charts-empty">
          {t('add.noChartData')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="top-charts-list">
          {charts.map((item, idx) => (
            <button
              key={`${item.feedUrl}-${idx}`}
              type="button"
              className="m-result-row"
              data-testid={`top-chart-item-${idx}`}
              onClick={() => onSelectResult(item)}
            >
              <span
                style={{
                  width: 24,
                  textAlign: 'right',
                  font: 'var(--md-sys-typescale-label-medium)',
                  color: 'var(--md-sys-color-on-surface-variant)',
                }}
              >
                {idx + 1}
              </span>
              <ArtworkImage
                src={item.imageUrl}
                allowProxyFallback={shouldUseImageProxy(host.info.platform)}
                className="m-result-row__cover"
                loading="lazy"
                placeholder={
                  <div className="m-result-row__cover" style={{ display: 'grid', placeItems: 'center' }}>
                    <Icon name="podcasts" size={22} />
                  </div>
                }
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ font: 'var(--md-sys-typescale-title-small)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.title}
                </div>
                {item.author && (
                  <div style={{ font: 'var(--md-sys-typescale-body-small)', color: 'var(--md-sys-color-on-surface-variant)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.author}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
