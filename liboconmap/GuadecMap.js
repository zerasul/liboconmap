class GuadecMap {
    constructor(options){
        this.overpass_url = 'https://overpass-api.de/api/interpreter';
        this.options = options;
    }

    /* Functions and helpers */
    /* from https://www.npmjs.com/package/geojson-polygon-center */
    static polygon_center(polygon) {
        var minx = 1000,
            miny = 1000,
            maxx = -1000,
            maxy = -1000,
            polygon = polygon[0];
        for (var i = 0; i < polygon.length; i++) {
            var point = polygon[i]
            var x = point[0]
            var y = point[1]

            if (x < minx) minx = x
            else if (x > maxx) maxx = x
            if (y < miny) miny = y
            else if (y > maxy) maxy = y
        }

        return {
            type: 'Point',
            coordinates: [
            minx + ((maxx - minx) / 2),
            miny + ((maxy - miny) / 2)
            ]
        }
    }

    _get_routes(context, geometries){
        // Data needed
        var default_color = context.options.main_color;
        var map = context.map;
        var routes = context.options.routes;
        var token = context.options.mapbox_token;

        var get_coordinates = function(id){
            var cand = geometries.filter(x => x.id == id );
            if (cand.length ==1){
                return cand[0];
            } else {
                return undefined;
            }
        };

        var get_route = function(coords,method) {
            var base_url = 'https://api.mapbox.com/directions/v5/mapbox/'+method;
            var params = {
                'overview': 'full',
                'geometries': 'polyline6',
                'access_token': token
            };

            // Transform to string
            var coordinates = coords.map(c => c.coordinates).map( c => c.join(',')).join(';');
            var params_str = Object.keys(params).map( p => `${p}=${params[p]}`).join('&');
            // Final URL to get data from Mapbox
            var url = `${base_url}/${coordinates}.json?${params_str}`
    
            return fetch(url).then(response => response.json())
        };

        var features_promises = routes.map(function(route){
            return new Promise((resolve,reject) => {
                // Get route data 
                var coords = route.waypoints.map(get_coordinates);
                // var from = get_coordinates(route['from']);
                // var to = get_coordinates(route['to']);
                var title = route['title'];
                var color = route['color'];
                var description = route['description'];
                var method = route['method'] || 'driving';

                if (coords.length >= 2){ 
                    get_route(coords,method)
                        .then(function(route){
                            if (route.routes){
                                var the_route = route.routes[0];
                                resolve({
                                            type : 'Feature',
                                            geometry : polyline.toGeoJSON(the_route.geometry,6),
                                            properties : {
                                                distance : the_route['distance'],
                                                duration: the_route['duration'],
                                                name : title,
                                                color : color,
                                                description: description
                                            }
                                })                             
                            } else {
                                reject({
                                    error : 'no routes found',
                                    data : route
                                });
                            }
                        });
                } else {
                    reject({
                        'error' : 'bad data',
                        'data' : route
                    });
                }
            });
        });

        Promise.all(features_promises)
            .then(function(values){
                /* Route layer */
                map.addLayer({
                    'id': 'guadec_routes',
                    'type': 'line',
                    'source': {
                        'type': 'geojson',
                        'data':  {
                            'type' : 'FeatureCollection',
                            'features': values
                        }
                    },
                    'layout': {},
                    'paint': {    
                        "line-color":[
                            "case",
                            ["has", 'color'], ["get", "color"],
                            default_color,
                        ],
                        "line-width": 2
                    }
                },'boundary_country_inner');
            })
            .catch( error => console.error(error));
    }
    
    /* This method initializes and returns a Mapbox map instance
    with the interacitivity ready to be used */
    init_map(){
        var context = this;
        var options = context.options;
        var env = options.environment;

        return new Promise(function(resolve,reject){
            fetch(options.basemap_style)
            .then(response => response.json())
            .then(style =>{
                if (env == 'DEV'){
                    console.log('Using localhost sprite');
                    style['sprite'] = 'http://localhost:8000/liboconmap/sprite';
                } else {
                    console.log('Using guadecwebsite sprite');
                    style['sprite'] = 'http://olea.org/~zerasul/liboconmap/sprite';
                }

                var map = new mapboxgl.Map({
                    container: 'map',
                    style: options.tweak_style(style, options),
                    center: options.center,
                    zoom: options.zoom,
                    attributionControl: true,
                    hash: true
                });
                
                /* Navigation control */
                map.addControl(new mapboxgl.NavigationControl());
                
                /* Popup up singleton */
                var tooltip = new mapboxgl.Popup({   
                    closeButton: false,
                    closeOnClick: true,
                    anchor: "top",
                    offset: [0, 8]
                });
                
                // helper to render the properties
                var get_properties_list = function(properties){
                    return options.popup_properties
                    .filter(function(key){
                        return (Object.keys(properties).findIndex(x => x == key) > -1)
                    })
                    .map(function(key){
                        if (key == 'website'){
                            return `<li><a href="${properties[key]}">${key}</a></li>`
                        } else if (key == 'wikidata'){
                            return `<li><a href="https://www.wikidata.org/wiki/${properties[key]}">${key}</a></li>`
                        } else if (key == 'wikipedia'){
                            return `<li><a href="https://en.wikipedia.org/wiki/${properties[key]}">${key}</a></li>`
                        } else if (key == 'picture') {
                            return `<li><a href="${properties[key]}">Picture</a></li>`
                        } else {
                            return `<li><strong>${key}</strong>: ${properties[key]}</li>`
                        }
                    }).join('')
                };
        
                var interactivity_handler = function(location,is_tooltip){
                    if (! map.getLayer('guadec_icon') || ! map.getLayer('guadec_routes')) return;
                    
                    var features_icons = map.queryRenderedFeatures(location.point, { layers: ['guadec_icon'] });
                    var features_routes = map.queryRenderedFeatures(location.point, { layers: ['guadec_routes'] });
                    
                    // remove previous interactivity elements
                    tooltip.remove();
                    if (typeof map.getLayer('selected_route') !== "undefined" ){
                        map.removeLayer('selected_route')
                        map.removeSource('selected_route');   
                    }
                    
                    if (features_icons != ''){
                        var feature = features_icons[0];
                        var popup = null;
                        var popup_content = null;
        
                        if (is_tooltip){
                            popup = tooltip;
        
                            if (feature.properties.cluster){
                                popup_content = `<span>${feature.properties.point_count} points</span>`;
                            } else {
                                popup_content = `<span>${feature.properties.name}</span>`;
                            }
                        } else {
                            popup = new mapboxgl.Popup({
                                anchor:'bottom',
                                closeOnClick: true,
                                className:'guadec-popup'
                            })
                            
                            if (feature.properties.cluster){
                                popup_content = `<h3>${feature.properties.point_count} points</h3>`;
                            } else {
                                popup_content = `
                                <h3>${feature.properties.name}</h3>
                                <ul>
                                    ${get_properties_list(feature.properties)}
                                    </ul>
                                    <p class="osm-source">
                                    <a href="https://www.openstreetmap.org/${feature.properties.type}/${feature.properties.id}">
                                    Source
                                    </a>
                                    </p>
                                `;
                            }
        
                            
                        }
                        
                        popup.setHTML(popup_content)
                        .setLngLat(location.lngLat) 
                            .addTo(map);
                            
                        } else if ( features_routes != '') {
                            var feature = features_routes[0];
                            var highlight_color = tinycolor(options.main_color).lighten(20);
                            
                            // Render the feature
                            map.addSource('selected_route', {
                            "type":"geojson",
                            "data": feature.toJSON()
                        });
                        map.addLayer({
                            "id": "selected_route",
                            "type": "line",
                            "source": "selected_route",
                            "layout": {
                                "line-join": "round",
                                "line-cap": "round"
                            },
                            "paint": {
                                "line-color": highlight_color.toHexString(),
                                "line-width": 8
                            }
                        },'guadec_routes');
        
                        // Render the interactivity
                        
                        var popup = null;
                        var popup_content = null;
                        
                        if (is_tooltip){
                            popup = tooltip;
                            popup_content = `<span>${feature.properties.name}</span>`;
                        } else {
                            popup = new mapboxgl.Popup({
                                anchor:'bottom',
                                closeOnClick: true,
                                className:'guadec-popup'
                            });
                            popup_content = `
                                <h3>${feature.properties.name}</h3> 
                                <p>${feature.properties.description}</p>`;
                                
                        }
        
                        popup.setHTML(popup_content)
                            .setLngLat(location.lngLat) 
                            .addTo(map);
                    }
                }
        
                /* Popup interactivity */
                map.on('click',function(location){
                    interactivity_handler(location,false);
                });
                
                
                /* Popup interactivity */
                map.on('mousemove',function(location){
                    interactivity_handler(location,true);
                });
                
                context.map = map;
                resolve(map);
            }).catch(error => reject(error));
        })        
    }
    
    /* Get data from OSM and return a promise when is parsed */
    fetch_data(){
        var context = this,
            _get_osm_query= function(options){
                var _get_ids = el => typeof el == "number" ? el : el['osm_id'];
        
                var ways = options.osm_ways.map(_get_ids).join(',');
                var nodes = options.osm_nodes.map(_get_ids).join(',');
        
                return `[out:xml][timeout:300];
                        (
                            way(id:${ways});
                            node(id:${nodes});
                        )->.a;
                        (.a; .a >;);out qt;`
            };
        
        console.log('fetching osm data...')

        return fetch(this.overpass_url,{
            method: "POST",
            body:  _get_osm_query(this.options)
        })
        .then(response => response.text())
        .then(str => (new window.DOMParser()).parseFromString(str, "text/xml"))
    }
    
    
    /* transforms OSM data into geojson and adds that as
        points and labels to the map */
    process_osm_data(data){
        console.log('loading data...');
        var context = this,
            // Convert to GeoJSON
            geojson_data = osmtogeojson(data),
            // Filter ways
            polys_geojson = geojson_data.features.filter(function(feature){
                return feature.properties.type == "way"
            }),
            // Filter points
            points_geojson = geojson_data.features.filter(function(feature){
                return feature.properties.type == "node"
            }),
            // Generate centroids for points
            polys_geojson_points = polys_geojson.map(function(poly){
                var copy = JSON.parse(JSON.stringify(poly));
                copy['geometry'] = GuadecMap.polygon_center(copy.geometry.coordinates);
                return copy
            }),
            // Get together both set of points
            all_features = points_geojson.concat(polys_geojson_points),
            // Get all properties out from the tags
            points_geojson_props = all_features.map(function(feature){
                    var properties = feature['properties'],
                        tags = properties['tags'];
                    Object.assign(properties, tags);
                    delete properties['tags'];
            
                    if (properties['id'] == undefined){
                        properties['id'] = String(feature['id'])
                    } else {
                        properties['id'] = String(properties['id'])
                    };
            
                    // Override the name in Engish, if it exists
                    if (properties['name:en'] != undefined){
                        properties['name'] = properties['name:en']
                    };
            
                    return feature
                }
            ),
            /* takes a feature, and augment it with any custom properties 
            passed on thi list of nodes and ways */
            final_points = points_geojson_props.map(function(feature){
                var options = context.options,
                    /* filter checker */
                    filter_node = function(node){
                        return typeof node != "number" && node['osm_id'] == feat_id;
                    },
                    properties = feature['properties'],
                    /* feature id */
                    feat_id = properties['id'],
                    /* candidates */
                    candidate = options.osm_nodes.filter(filter_node)
                                    .concat(options.osm_ways.filter(filter_node));

                if (candidate.length == 1){
                    properties = Object.assign(properties,candidate[0]);
                };

                return feature;
            });

        context.geojson_data = {
            'type': 'FeatureCollection',
            'features': final_points
        }; 

        // Build final geojson collection
        return  context.geojson_data;         
        }
    
    load_pois(){
        var geojson_data = this.geojson_data;
        var options = this.options;
        var map = this.map;
        var poi_color = tinycolor(options.main_color).darken().toHexString();

        /* Icon layer */
        map.addLayer({
            'id': 'guadec_icon',
            'type': 'symbol',
            'source': {
                'type': 'geojson',
                'data': geojson_data,
                'cluster' : true,
                'clusterMaxZoom': 12
            },
            'layout': {
                "symbol-placement": "point",
                "text-field": '{name}' ,
                "icon-image": [
                    "case",
                    ["has", 'icon'], ["get", "icon"],
                    options.icon,
                ],
                "text-font": ["Open Sans Regular"],
                "icon-allow-overlap": true,
                "text-offset": [.3,.3],
                "text-anchor": "top-left",
                "text-max-width": 5,
                "text-justify": "left",
                "text-allow-overlap": false,
                "text-optional": true,
                "icon-size": {
                    "stops": [
                        [0, 0.1],
                        [12, 0.7],
                        [13,0.5],
                        [20, 1.5],
                    ]
                },
                "text-size": {
                    "stops": [
                        [0, 0],
                        [9,0],
                        [12, 15],
                        [16, 20]
                    ]
                }
            },
            'paint': {
                "text-color": poi_color,
                "icon-opacity": 1,
                "text-opacity": {
                    "stops": [
                        [0, 0],
                        [9,0],
                        [12, 1]
                    ]
                },
                "text-halo-color": "white",
                "text-halo-width": 2,
                "text-halo-blur": 1
            }
        },'place_hamlet');
    }
    
    load_routes(){
        var routes = this.options.routes;
        var data = this.geojson_data;
        
        // generate a list of nodes and geometries
        var geom_ids = data.features.map(function(feature){
            return {
                'id'       : feature.properties['id' ], 
                'coordinates' : feature.geometry.coordinates
            }
        });

        var geom_ids_ids = geom_ids.map(x => x.id);
        
        // get the list of route waypoint ids not appearing in that list
        var new_ids = Array.from(new Set (
            [].concat.apply([], 
                routes.map(function(route){
                    return route.waypoints.filter( point => geom_ids_ids.indexOf(String(point)) == -1)
                })
            )
            .filter(x => x != undefined)
        ));
        
        // if needed get from overpass the rest of the geometries        
        if (new_ids.length>0){
            var overpass_url = this.overpass_url;
            var get_osm_geoms = new Promise(function(resolve,reject){
                var new_ids_str = new_ids.join(',');
                var osm_query = `[out:json][timeout:300];node(id:${new_ids_str}); out skel qt;`;
                
                console.log('Fetching more data from OSM for the routes');
                fetch(overpass_url,{ method: "POST", body:  osm_query })
                .then(response => response.json())
                .then(function(data){
                    resolve(
                        geom_ids.concat(
                            data.elements.map(function(data){
                                return { 'id': data.id, 'coordinates' : [data.lon, data.lat] }
                            })
                        )
                    );
                });      
            });
        } else {
            var get_osm_geoms = Promise.resolve(geom_ids);
        }
        
        /* 
            When the data is here, all set up to get the routes
            from Mapbox
        */
        var context = this;
        get_osm_geoms.then(function(all_geom_ids){
            context._get_routes(context,all_geom_ids);
        });
    }
}

window.GuadecMap = GuadecMap;