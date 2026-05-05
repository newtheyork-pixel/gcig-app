import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

const SIZE_COLORS = {
  vlcc: '#C9A84C',
  suezmax: '#1B2A4A',
  aframax: '#5B6B89',
  small: '#9CA3AF',
  unknown: '#9CA3AF',
};

// Rough approximation of the Persian Gulf zone where contributing
// terrestrial AIS receivers are sparse — Iranian coastal waters and
// the Iraqi/Kuwaiti head. Vessels sitting at Iranian terminals or
// loitering in the inner north Gulf don't appear in this feed until
// they sail outward into Strait of Hormuz coverage. Drawing the gap
// is more honest than letting members assume the empty area is empty
// water. Polygon is intentionally coarse — receiver coverage is not
// publicly mapped, and a tighter shape would imply false precision.
const COVERAGE_GAP_POLYGON = [[
  [47.6, 30.5],
  [56.4, 27.0],
  [56.4, 26.5],
  [54.5, 26.6],
  [52.0, 27.3],
  [49.5, 28.3],
  [48.0, 29.6],
  [47.6, 30.5],
]];

// OpenFreeMap is a free, no-key, no-rate-limit, OSM-derived vector
// tile host. We use the "positron" light style — neutral background
// so the gold/navy vessel + terminal markers read clearly. Direct
// OSM raster tiles tend to fail under any real load (their public
// server has UA filtering and aggressive rate limits) and can leave
// the map blank in production.
const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

export default function VesselMap({ snapshot, onVesselClick }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const dataRef = useRef({ vessels: [], terminals: [], bbox: null });
  const clickHandlerRef = useRef(onVesselClick);

  // Keep the click handler ref in sync without recreating the map.
  useEffect(() => { clickHandlerRef.current = onVesselClick; }, [onVesselClick]);

  // Initialize once.
  useEffect(() => {
    if (!containerRef.current) return undefined;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: [52.5, 26.5],
      zoom: 5,
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    map.on('load', () => {
      map.addSource('vessels', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('trails', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('terminals', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('coverage-gap', {
        type: 'geojson',
        data: {
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: COVERAGE_GAP_POLYGON },
          properties: {},
        },
      });

      // Drawn first so trails / vessels / terminals all sit above it.
      map.addLayer({
        id: 'coverage-gap-fill',
        type: 'fill',
        source: 'coverage-gap',
        paint: {
          'fill-color': '#1B2A4A',
          'fill-opacity': 0.08,
        },
      });
      map.addLayer({
        id: 'coverage-gap-outline',
        type: 'line',
        source: 'coverage-gap',
        paint: {
          'line-color': '#1B2A4A',
          'line-width': 1.2,
          'line-opacity': 0.5,
          'line-dasharray': [3, 3],
        },
      });

      map.addLayer({
        id: 'trails-line',
        type: 'line',
        source: 'trails',
        paint: {
          'line-color': '#1B2A4A',
          'line-width': 1,
          'line-opacity': 0.25,
        },
      });

      map.addLayer({
        id: 'vessels-dot',
        type: 'circle',
        source: 'vessels',
        paint: {
          'circle-radius': 5,
          'circle-color': ['coalesce', ['get', 'color'], '#9CA3AF'],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1,
        },
      });

      map.addLayer({
        id: 'terminals-pin',
        type: 'circle',
        source: 'terminals',
        paint: {
          'circle-radius': 6,
          'circle-color': '#C9A84C',
          'circle-stroke-color': '#1B2A4A',
          'circle-stroke-width': 2,
        },
      });

      map.on('click', 'vessels-dot', (e) => {
        const feat = e.features && e.features[0];
        if (!feat) return;
        const props = feat.properties || {};
        const vessel = dataRef.current.vessels.find((v) => v.mmsi === Number(props.mmsi));
        if (vessel && clickHandlerRef.current) clickHandlerRef.current(vessel);
      });
      map.on('mouseenter', 'vessels-dot', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'vessels-dot', () => { map.getCanvas().style.cursor = ''; });
    });

    return () => map.remove();
  }, []);

  // Push data whenever the snapshot changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !snapshot) return;
    dataRef.current = snapshot;

    const apply = () => {
      const vesselFeatures = (snapshot.vessels || []).map((v) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [v.lon, v.lat] },
        properties: {
          mmsi: v.mmsi,
          color: SIZE_COLORS[v.sizeClass || 'unknown'] || SIZE_COLORS.unknown,
        },
      }));
      const trailFeatures = (snapshot.vessels || [])
        .filter((v) => Array.isArray(v.trail) && v.trail.length >= 2)
        .map((v) => ({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: v.trail.map(([lat, lon]) => [lon, lat]),
          },
          properties: { mmsi: v.mmsi },
        }));
      const terminalFeatures = (snapshot.terminals || []).map((t) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
        properties: { name: t.name, country: t.country },
      }));

      const v = map.getSource('vessels');
      const tr = map.getSource('trails');
      const te = map.getSource('terminals');
      if (v) v.setData({ type: 'FeatureCollection', features: vesselFeatures });
      if (tr) tr.setData({ type: 'FeatureCollection', features: trailFeatures });
      if (te) te.setData({ type: 'FeatureCollection', features: terminalFeatures });
    };

    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [snapshot]);

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="h-[600px] w-full rounded-2xl border border-navy/10 shadow-sm"
      />
      <div className="pointer-events-none absolute bottom-3 left-3 max-w-[260px] rounded-lg border border-navy/10 bg-white/90 px-3 py-2 text-xs text-navy/70 shadow-sm backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-3 w-5 border border-dashed border-navy/50"
            style={{ backgroundColor: 'rgba(27,42,74,0.08)' }}
          />
          <span className="font-medium text-navy">Limited AIS coverage</span>
        </div>
        <p className="mt-1 leading-snug">
          Iranian coast and inner north Gulf — terrestrial receivers don't reach.
          Vessels here only appear once they sail into strait coverage.
        </p>
      </div>
    </div>
  );
}
