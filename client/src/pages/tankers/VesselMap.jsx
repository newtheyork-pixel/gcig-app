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

// Free OpenStreetMap raster style. Comes with a sensible attribution
// requirement which MapLibre renders automatically.
const RASTER_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
      maxzoom: 19,
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

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
      style: RASTER_STYLE,
      center: [52.5, 26.5],
      zoom: 5,
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    map.on('load', () => {
      map.addSource('vessels', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('trails', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('terminals', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

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
    <div
      ref={containerRef}
      className="h-[600px] w-full rounded-2xl border border-navy/10 shadow-sm"
    />
  );
}
