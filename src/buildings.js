/* Here we define buildingify and all other functions and definitions it relies on. */

let bearing = require('@turf/bearing').default,
destination = require('@turf/destination').default,
along = require('@turf/along').default,
lineIntersect = require('@turf/line-intersect').default,
intersect = require('@turf/intersect').default,
Agentmap = require('./agentmap').Agentmap,
streetsToGraph = require('./routing').streetsToGraph,
getPathFinder = require('./routing').getPathFinder;

/**
 * Generate and setup the desired map features (e.g. streets, houses).
 *
 * @param {Array.<Array.<number>>} bounding_box - The map's top-left and bottom-right coordinates.
 * @param {object} OSM_data - A GeoJSON Feature Collection object containing the OSM features inside the bounding box.
 */
function buildingify(bounding_box, OSM_data) {
	setupStreetFeatures.call(this, OSM_data);
	setupUnitFeatures.call(this, bounding_box, OSM_data);
}

/**
 * Generate and setup streets based on the provided GeoJSON data.
 *
 * @param {object} OSM_data - A GeoJSON Feature Collection object containing the OSM features inside the bounding box.
 */
function setupStreetFeatures(OSM_data) {
	let street_features = getStreetFeatures(OSM_data);
	
	let street_options = {
		style: {
			"color": "yellow",
			"weight": 4,
			"opacity": .5
		},
	};

	let street_feature_collection = {
		type: "FeatureCollection",
		features: street_features
	};

	this.streets = L.geoJSON(
		street_feature_collection,
		street_options
	).addTo(this.map);

	//Having added the streets as layers to the map, do any processing that requires access to those layers.
	this.streets.eachLayer(function(street) {
		addStreetLayerIntersections.call(this, street);
	}, this);

	this.streets.graph = streetsToGraph(this.streets),
	this.pathfinder = getPathFinder(this.streets.graph);
}

/**
 * Get all streets from the GeoJSON data.
 * @private
 *
 * @param {Object} OSM_data - A GeoJSON Feature Collection object containing the OSM streets inside the bounding box.
 * @returns {Array<Feature>} -  array of street features.
 */
function getStreetFeatures(OSM_data) {
	let street_features = [];

	for (let i =  0; i < OSM_data.features.length; ++i) {
		let feature = OSM_data.features[i];
		
		if (feature.geometry.type === "LineString" && feature.properties.highway) {
			let street_feature = feature;

			street_features.push(street_feature);
		}
	}

	return street_features;
}

/**
 * Gets the intersections of all the streets on the map and adds them as properties to the street layers.
 * @private
 * 
 * @param {object} street - A Leaflet polyline representing a street.
 */
function addStreetLayerIntersections(street) {
	let street_id = street._leaflet_id;

	street.intersections = typeof(street.intersections) === "undefined" ? {} : street.intersections;

	this.streets.eachLayer(function(other_street) {
		let other_street_id = other_street._leaflet_id;

		//Skip if both streets are the same, or if the street already has its intersections with the other street.
		if (typeof(street.intersections[other_street_id]) === "undefined" && street_id !== other_street_id) {
			let street_coords = street.getLatLngs().map(L.A.pointToCoordinateArray),
			other_street_coords = other_street.getLatLngs().map(L.A.pointToCoordinateArray),
			identified_intersections = L.A.getIntersections(street_coords, other_street_coords, [street_id, other_street_id]).map(
				identified_intersection => 
				[L.A.reversedCoordinates(identified_intersection[0]), identified_intersection[1]]
			);

			if (identified_intersections.length > 0) {
				street.intersections[other_street_id] = identified_intersections,
				other_street.intersections = typeof(other_street.intersections) === "undefined" ? {} : other_street.intersections,
				other_street.intersections[street_id] = identified_intersections;
			}
		}
	});
}

/**
 * Generate and setup building units based on the provided GeoJSON data.
 *
 * @param {Array.<Array.<number>>} bounding_box - The map's top-left and bottom-right coordinates.
 * @param {object} OSM_data - A GeoJSON Feature Collection object containing the OSM features inside the bounding box.
 */
function setupUnitFeatures(OSM_data) {
	//Bind getUnitFeatures to "this" so it can access the agentmap as "this.agentmap".
	let unit_features = getUnitFeatures.bind(this)(OSM_data, bounding_box);

	let unit_options = {
		style: {
			"color": "green",
			"weight": 1,
			"opacity": .87
		},
	};

	let unit_feature_collection = { 
		type: "FeatureCollection", 
		features: unit_features
	};
	
	this.units = L.geoJSON(
		unit_feature_collection,
		unit_options
	).addTo(this.map);

	//Having added the units as layers to the map, do any processing that requires access to those layers.
	this.units.eachLayer(function(unit) {
		unit.street_id = unit.feature.properties.street_id,
		unit.street_anchors = unit.feature.properties.street_anchors,
		//Change the IDs of each unit in this unit's neighbours array into the appropriate Leaflet IDs.
		unit.neighbors = getUnitNeighborLayerIDs.call(this, unit.feature.properties.neighbors);
	}, this);
}

/**
 * Get all appropriate units within the desired bounding box.
 * @private
 *
 * @param {Object} OSM_data - A GeoJSON Feature Collection object containing the OSM features inside the bounding box.
 * @returns {Array<Feature>} -  array of features representing real estate units.
 */
function getUnitFeatures(OSM_data, bounding_box) {
	let proposed_unit_features = [];
	
	this.streets.eachLayer(function(layer) {
		let street_feature = layer.feature,
		street_id = layer._leaflet_id,
		proposed_anchors = getUnitAnchors(street_feature, bounding_box),
		new_proposed_unit_features = generateUnitFeatures(proposed_anchors, proposed_unit_features, street_id);
		proposed_unit_features.push(...new_proposed_unit_features);
	});

	unit_features = unitsOutOfStreets(proposed_unit_features, this.streets);

	return unit_features;
}

/**
 * Given two anchors, find four nearby points on either side
 * of the street appropriate to build a unit(s) on.
 * @private
 *
 * @param {Array<Array<Feature>>} unit_anchors -  array of pairs of points around which to anchor units along a street.
 * @param {Array<Feature>} proposed_unit_features -  array of features representing real estate units already proposed for construction.
 * @param {string} street_feature_id - The Leaflet layer ID of the street feature along which the unit is being constructed..
 * @returns {Array<Feature>} unit_features -  array of features representing real estate units.
 */
function generateUnitFeatures(unit_anchors, proposed_unit_features, street_feature_id) {
	//One sub-array of unit features for each side of the road.
	let unit_features = [[],[]],
	starting_id = proposed_unit_features.length,
	increment = 1;
	
	for (let anchor_pair of unit_anchors) {
		//Pair of unit_features opposite each other on a street.
		let unit_pair = [null, null];
		
		for (let i of [1, -1]) {
			let anchor_a = anchor_pair[0].geometry.coordinates,
			anchor_b = anchor_pair[1].geometry.coordinates,
			anchor_latLng_pair = [anchor_a, anchor_b],
			street_buffer = 6 / 1000, //Distance between center of street and start of unit.
			house_depth = 18 / 1000,
			angle = bearing(anchor_a, anchor_b),
			new_angle = angle <= 90 ? angle + i * 90 : angle - i * 90, //Angle of line perpendicular to the anchor segment.
			unit_feature = { 
				type: "Feature",
				properties: {
					street: "none"
				},
				geometry: {
					type: "Polygon",
					coordinates: [[]]
				}
			};
			unit_feature.geometry.coordinates[0][0] = destination(anchor_a, street_buffer, new_angle).geometry.coordinates,
			unit_feature.geometry.coordinates[0][1] = destination(anchor_b, street_buffer, new_angle).geometry.coordinates,
			unit_feature.geometry.coordinates[0][2] = destination(anchor_b, street_buffer + house_depth, new_angle).geometry.coordinates,
			unit_feature.geometry.coordinates[0][3] = destination(anchor_a, street_buffer + house_depth, new_angle).geometry.coordinates;
			unit_feature.geometry.coordinates[0][4] = unit_feature.geometry.coordinates[0][0];

			//Exclude the unit if it overlaps with any of the other proposed units.
			let all_proposed_unit_features = unit_features.concat(...proposed_unit_features); 
			if (noOverlaps(unit_feature, all_proposed_unit_features)) { 
				//Recode index so that it's useful here.
				if (i === 1) {
					i = 0;
				}
				else {
					i = 1;
				}

				unit_feature.properties.street_id = street_feature_id,
				unit_feature.properties.street_anchors = anchor_latLng_pair,	
				unit_feature.properties.neighbors = [null, null, null],
				unit_feature.properties.id = starting_id + increment,
				increment += 1;
				
				if (unit_features[i].length !== 0) {
					//Make previous unit_feature this unit_feature's first neighbor.
					unit_feature.properties.neighbors[0] = unit_features[i][unit_features[i].length - 1],
					//Make this unit_feature the previous unit_feature's second neighbor.
					unit_features[i][unit_features[i].length - 1].properties.neighbors[1] = unit_feature;
				}
				
				if (i === 0) {
					unit_pair[0] = unit_feature;
				}
				else {
					//Make unit_feature opposite to this unit_feature on the street its third neighbor.
					unit_feature.properties.neighbors[2] = unit_pair[0],
					//Make unit_feature opposite to this unit_feature on the street's third neighbor this unit_feature.
					unit_pair[0].properties.neighbors[2] = unit_feature,

					unit_pair[1] = unit_feature;
				}
			}
		}
		
		if (unit_pair[0] !== null) {
			unit_features[0].push(unit_pair[0]);
		}

		if (unit_pair[1] !== null) {
			unit_features[1].push(unit_pair[1]);
		}
	}

	let unit_features_merged = [].concat(...unit_features);

	return unit_features_merged;
}

/**
 * Find anchors for potential units. chors are the pairs of start 
 * and end points along the street from which units may be constructed.
 * @private
 * 
 * @param {Feature} street_feature - A GeoJSON feature object representing a street.
 * @returns {Array<Array<Feature>>} - Array of pairs of points around which to anchor units along a street.  
 */
function getUnitAnchors(street_feature, bounding_box) {
	let unit_anchors = [],
	unit_length = 14 / 1000, //Kilometers.
	unit_buffer = 3 / 1000, //Distance between units, kilometers.
	endpoint = street_feature.geometry.coordinates[street_feature.geometry.coordinates.length - 1],
	start_anchor = along(street_feature, 0),
	end_anchor = along(street_feature, unit_length),
	distance_along = unit_length;
	
	while (end_anchor.geometry.coordinates != endpoint) {
		//Exclude proposed anchors if they're outside of the bounding box.
		start_coord = L.A.reversedCoordinates(start_anchor.geometry.coordinates), 
		end_coord = L.A.reversedCoordinates(end_anchor.geometry.coordinates);
		if (L.latLngBounds(bounding_box).contains(start_coord) &&
			L.latLngBounds(bounding_box).contains(end_coord)) {
				unit_anchors.push([start_anchor, end_anchor]);
		}

		//Find next pair of anchors.
		start_anchor = along(street_feature, distance_along + unit_buffer);
		end_anchor = along(street_feature, distance_along + unit_buffer + unit_length);
		
		distance_along += unit_buffer + unit_length
	}

	return unit_anchors;
}

/**
 * Get an array of units excluding units that overlap with streets.
 * @private
 *
 * @param {Array<Feature>} unit_features - ray of features representing units.
 * @param {Array<Layer>} street_layers - ray of Leaflet layers representing streets.
 * @returns {Array<Feature>} - unit_features, but with all units that intersect any streets removed.
 */
function unitsOutOfStreets(unit_features, street_layers) {
	let processed_unit_features = unit_features.slice();
	
	street_layers.eachLayer(function(street_layer) {
		let street_feature = street_layer.feature;
		for (let unit_feature of processed_unit_features) {
			let intersection_exists = lineIntersect(street_feature, unit_feature).features.length > 0;
			if (intersection_exists) {
				processed_unit_features.splice(processed_unit_features.indexOf(unit_feature), 1, null);
			}
		}	
	
		processed_unit_features = processed_unit_features.filter(feature => feature === null ? false : true);
	});
	

	return processed_unit_features;
}

/**
 * Check whether a polygon overlaps with any member of an array of polygons.
 * @private
 *
 * @param {Feature} polygon_feature - A geoJSON polygon feature.
 * @param {Array<Feature>} polygon_feature_array -  array of geoJSON polygon features.
 * @returns {boolean} - Whether the polygon_feature overlaps with any one in the array.
 */	
function noOverlaps(reference_polygon_feature, polygon_feature_array) {
	return true;
	for (feature_array_element of polygon_feature_array) {
		let overlap_exists = intersect(reference_polygon_feature, feature_array_element);
		if (overlap_exists) {
			return false;
		}
	}
	return true;
}

/**
 * Given an array of pre-layer IDs, check if any of them correspond to the pre-layer IDs of unit layers, and if so
 * return an array of the corresponding layer IDs.
 * @private
 *
 * @param {Array<?number>} - An array of pre-layer feature IDs for a unit's neighbors.
 * @returns {Array<?number>} - An array of Leaflet layer IDs corresponding to the unit's neighbors.
 */
function getUnitNeighborLayerIDs(neighbors) {
	console.log("n", neighbors);
	let neighbor_layer_ids = neighbors.map(function(neighbor) {
		if (neighbor !== null) {
			let neighbor_layer_id = null;
			this.units.eachLayer(function(possible_neighbor_layer) {
				if (possible_neighbor_layer.feature.properties.id === neighbor.properties.id) {
					neighbor_layer_id = this.units.getLayerId(possible_neighbor_layer);
				}
			}, this);

			return neighbor_layer_id;
		}
		else {
			return null;
		}
	}, this);
	console.log("nl", neighbor_layer_ids);
	return neighbor_layer_ids;
}

Agentmap.prototype.buildingify = buildingify;
