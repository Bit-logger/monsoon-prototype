import React, { useState } from 'react';
import { MapContainer, TileLayer, LayersControl, LayerGroup, useMap, Polyline, Marker, Polygon } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import './App.css';
import L from 'leaflet';
import * as turf from '@turf/turf';

import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';

// Fix for default marker icon
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
    iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
    iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
    shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

// A component to handle map interactions like drawing the polyline
function MapUpdater({ routeCoordinates }) {
    const map = useMap();
    if (routeCoordinates && routeCoordinates.length > 0) {
        const bounds = L.latLngBounds(routeCoordinates);
        map.flyToBounds(bounds);
    }
    return null;
}

// Function to create custom colored markers
const getMarkerIcon = (severity) => {
    let color = '';
    switch (severity) {
        case 'Low':
            color = 'green';
            break;
        case 'Medium':
            color = 'orange';
            break;
        case 'High':
            color = 'red';
            break;
        default:
            color = 'blue';
    }
    return new L.Icon({
        iconUrl: `https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-${color}.png`,
        shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
        iconSize: [25, 41],
        iconAnchor: [12, 41],
        popupAnchor: [1, -34],
        shadowSize: [41, 41]
    });
};

function App() {
    const [start, setStart] = useState('');
    const [end, setEnd] = useState('');
    const [route, setRoute] = useState(null);
    const [altRoute, setAltRoute] = useState(null);
    const [startPoint, setStartPoint] = useState(null);
    const [endPoint, setEndPoint] = useState(null);
    const [floodReports, setFloodReports] = useState([]);
    const [drawnItems, setDrawnItems] = useState([]);
    const [showWarning, setShowWarning] = useState(false);

    const center = [17.3850, 78.4867];

    const geocodeAddress = async (address) => {
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1`;
        try {
            const response = await fetch(url);
            const data = await response.json();
            if (data.length > 0) {
                return {
                    lat: parseFloat(data[0].lat),
                    lng: parseFloat(data[0].lon)
                };
            }
            return null;
        } catch (error) {
            console.error('Error geocoding address:', error);
            return null;
        }
    };

    const checkRouteForFloods = (routeCoords, reports, drawn) => {
        const routeLine = turf.lineString(routeCoords.map(coord => [coord[1], coord[0]]));
        
        // Check intersections with reported markers (buffers)
        for (const report of reports) {
            const point = turf.point([report.lng, report.lat]);
            const bufferedPoint = turf.buffer(point, 0.1, { units: 'kilometers' }); // 100m buffer
            if (turf.booleanIntersects(routeLine, bufferedPoint)) {
                return true;
            }
        }
        
        // Check intersections with drawn polygons
        for (const item of drawn) {
            if (item.type === 'rectangle' || item.type === 'polygon') {
                const polygon = turf.polygon(item.latlngs.map(ring => ring.map(coord => [coord[1], coord[0]])));
                if (turf.booleanIntersects(routeLine, polygon)) {
                    return true;
                }
            }
        }
        
        return false;
    };

    const getRoute = async () => {
        setRoute(null);
        setAltRoute(null);
        setStartPoint(null);
        setEndPoint(null);
        setShowWarning(false);

        if (!start || !end) {
            alert('Please enter both start and end points.');
            return;
        }

        const startCoords = await geocodeAddress(start);
        const endCoords = await geocodeAddress(end);

        if (!startCoords || !endCoords) {
            alert('Could not find one or both locations. Please try again.');
            return;
        }

        setStartPoint(startCoords);
        setEndPoint(endCoords);

        const url = `http://router.project-osrm.org/route/v1/driving/${startCoords.lng},${startCoords.lat};${endCoords.lng},${endCoords.lat}?overview=full&geometries=geojson`;

        try {
            const response = await fetch(url);
            const data = await response.json();

            if (data.routes && data.routes.length > 0) {
                const routeData = data.routes[0].geometry.coordinates;
                const routeCoordinates = routeData.map(coord => [coord[1], coord[0]]);
                setRoute(routeCoordinates);
                
                // Check for floods on the new route
                if (checkRouteForFloods(routeCoordinates, floodReports, drawnItems)) {
                    setShowWarning(true);
                    
                    // --- ALTERNATIVE ROUTE CALCULATION ---
                    // Find the closest flood zone to the start point of the route
                    let closestFloodZone = null;
                    let minDistance = Infinity;
                    const startPointTurf = turf.point([startCoords.lng, startCoords.lat]);

                    for (const report of floodReports) {
                        const point = turf.point([report.lng, report.lat]);
                        const distance = turf.distance(startPointTurf, point, { units: 'kilometers' });
                        if (distance < minDistance) {
                            minDistance = distance;
                            closestFloodZone = point;
                        }
                    }

                    for (const item of drawnItems) {
                        if (item.type === 'rectangle' || item.type === 'polygon') {
                            const polygon = turf.polygon(item.latlngs.map(ring => ring.map(coord => [coord[1], coord[0]])));
                            const distance = turf.pointToLineDistance(startPointTurf, turf.lineString(polygon.geometry.coordinates[0]), { units: 'kilometers' });
                            if (distance < minDistance) {
                                minDistance = distance;
                                closestFloodZone = polygon.geometry.coordinates[0];
                            }
                        }
                    }

                    if (closestFloodZone) {
                        // Find a point just before the flood zone on the main route
                        const mainRouteLine = turf.lineString(routeCoordinates.map(c => [c[1], c[0]]));
                        const nearestPointOnLine = turf.nearestPointOnLine(mainRouteLine, closestFloodZone);
                        const detourPoint = nearestPointOnLine.geometry.coordinates;

                        // Calculate two new routes to create a detour
                        const detourUrl1 = `http://router.project-osrm.org/route/v1/driving/${startCoords.lng},${startCoords.lat};${detourPoint[0] + 0.01},${detourPoint[1] + 0.01}?overview=full&geometries=geojson`;
                        const detourUrl2 = `http://router.project-osrm.org/route/v1/driving/${detourPoint[0] + 0.01},${detourPoint[1] + 0.01};${endCoords.lng},${endCoords.lat}?overview=full&geometries=geojson`;

                        const [response1, response2] = await Promise.all([
                            fetch(detourUrl1),
                            fetch(detourUrl2)
                        ]);

                        const [data1, data2] = await Promise.all([
                            response1.json(),
                            response2.json()
                        ]);

                        if (data1.routes && data1.routes.length > 0 && data2.routes && data2.routes.length > 0) {
                            const combinedRouteData = [...data1.routes[0].geometry.coordinates, ...data2.routes[0].geometry.coordinates];
                            const combinedRouteCoordinates = combinedRouteData.map(coord => [coord[1], coord[0]]);
                            setAltRoute(combinedRouteCoordinates);
                        }
                    }
                    // --- END OF ALTERNATIVE ROUTE CALCULATION ---
                } else {
                    setShowWarning(false);
                    setAltRoute(null);
                }
            } else {
                alert('Could not find a route.');
            }
        } catch (error) {
            console.error('Error fetching route:', error);
            alert('An error occurred while getting the route.');
        }
    };

    const streetView = (
        <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
    );

    const satelliteWithStreetOverlay = (
        <LayerGroup>
            <TileLayer
                attribution='Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
                url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            />
            <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                opacity={0.5}
            />
        </LayerGroup>
    );

    const MapGeoman = () => {
        const map = useMap();
        map.pm.addControls({
            position: 'topleft',
            drawMarker: false,
            drawPolyline: false,
            drawCircle: false,
            drawCircleMarker: false,
            drawText: false,
            drawRectangle: {
                shapeOptions: {
                    color: 'red',
                },
            },
            drawPolygon: {
                shapeOptions: {
                    color: 'red',
                },
            },
            editMode: true,
            dragMode: true,
            cutToolbar: false,
            removalMode: true,
            rotateMode: false,
        });
        
        map.on('pm:create', (e) => {
            const newDrawnItem = {
                id: Date.now(),
                type: e.shape,
                latlngs: e.layer.getLatLngs ? e.layer.getLatLngs() : e.layer.getLatLng(),
                color: 'red',
            };
            setDrawnItems((prevItems) => [...prevItems, newDrawnItem]);
        });
        
        return null;
    };
    
    const ReportPopup = () => {
      const map = useMap();
      map.on('click', (e) => {
        const popupContent = `
            <div style="font-family: Arial, sans-serif;">
                <h4 style="margin-top: 0;">Report Flood</h4>
                <p style="margin-bottom: 10px;">Select Severity Level:</p>
                <div style="display: flex; gap: 10px;">
                    <button 
                        onclick="window.reportSeverity('Low', ${e.latlng.lat}, ${e.latlng.lng})" 
                        style="background-color: #4CAF50; color: white; border: none; padding: 10px 15px; border-radius: 5px; cursor: pointer;">
                        Low
                    </button>
                    <button 
                        onclick="window.reportSeverity('Medium', ${e.latlng.lat}, ${e.latlng.lng})" 
                        style="background-color: #FFC107; color: black; border: none; padding: 10px 15px; border-radius: 5px; cursor: pointer;">
                        Medium
                    </button>
                    <button 
                        onclick="window.reportSeverity('High', ${e.latlng.lat}, ${e.latlng.lng})" 
                        style="background-color: #F44336; color: white; border: none; padding: 10px 15px; border-radius: 5px; cursor: pointer;">
                        High
                    </button>
                </div>
            </div>
        `;
        L.popup()
          .setLatLng(e.latlng)
          .setContent(popupContent)
          .openOn(map);
      });

      return null;
    };

    window.reportSeverity = (severity, lat, lng) => {
        const newReport = {
            id: Date.now(),
            lat,
            lng,
            severity
        };
        setFloodReports(prevReports => [...prevReports, newReport]);
        document.querySelectorAll('.leaflet-popup-pane .leaflet-popup').forEach(popup => popup.remove());
    };

    return (
        <div className="app-container">
            <MapContainer
                center={center}
                zoom={13}
                style={{ height: "100vh", width: "100vw" }}
            >
                <MapGeoman />
                <ReportPopup />

                <div className="controls">
                    <input
                        type="text"
                        id="startInput"
                        placeholder="Start"
                        value={start}
                        onChange={(e) => setStart(e.target.value)}
                    />
                    <input
                        type="text"
                        id="endInput"
                        placeholder="Destination"
                        value={end}
                        onChange={(e) => setEnd(e.target.value)}
                    />
                    <button onClick={getRoute}>Calculate Route</button>
                </div>
                
                <LayersControl position="topright">
                    <LayersControl.BaseLayer checked name="Street View">
                        {streetView}
                    </LayersControl.BaseLayer>
                    <LayersControl.BaseLayer name="Satellite View">
                        {satelliteWithStreetOverlay}
                    </LayersControl.BaseLayer>
                </LayersControl>

                {route && (
                    <Polyline positions={route} color={showWarning ? 'red' : 'blue'} weight={5} opacity={0.7} />
                )}
                
                {altRoute && (
                    <Polyline positions={altRoute} color="green" weight={5} opacity={0.7} />
                )}
                
                {startPoint && <Marker position={startPoint} />}
                {endPoint && <Marker position={endPoint} />}

                {showWarning && (
                    <div className="alert-warning">
                        Warning: This route passes through a reported flood zone. An alternative route has been provided.
                    </div>
                )}
                
                {floodReports.map(report => (
                    <Marker
                        key={report.id}
                        position={[report.lat, report.lng]}
                        icon={getMarkerIcon(report.severity)}
                    >
                        <div
                            style={{
                                cursor: 'pointer',
                                background: 'white',
                                padding: '10px',
                                borderRadius: '5px',
                                border: `2px solid ${report.severity === 'High' ? 'red' : report.severity === 'Medium' ? 'orange' : 'green'}`
                            }}
                            dangerouslySetInnerHTML={{
                                __html: `<h4 style="margin: 0;">Flood Report</h4><p>Severity: <b>${report.severity}</b></p>`
                            }}
                        ></div>
                    </Marker>
                ))}
                
                {drawnItems.map((item) => {
                    if (item.type === 'rectangle' || item.type === 'polygon') {
                        return <Polygon key={item.id} positions={item.latlngs} color={item.color} />;
                    }
                    return null;
                })}

                <MapUpdater routeCoordinates={route || altRoute} />
            </MapContainer>
        </div>
    );
}

export default App;