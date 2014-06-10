// -*- coding: utf-8 -*-
// libgetmetadata - Collect metadata for creative works from various sources.
//
// Copyright 2014 Commons Machinery http://commonsmachinery.se/
//
// Authors: Peter Liljenberg <peter@commonsmachinery.se>
//          Artem Popov <artfwo@commonsmachinery.se>
//
// Distributed under an GPLv2 license, please see LICENSE in the top dir.

/* global document */

'use strict';

var _nodejs = (typeof module !== 'undefined' && typeof module.exports !== 'undefined');

if (_nodejs) {
    var xhr = require('xmlhttprequest');
    var jsdom = require('jsdom');
    var uuid = require('uuid');
    var rdfa = require('./RDFaProcessor.js');

    var RDFaProcessor = rdfa.RDFaProcessor;
    var XMLHttpRequest = xhr.XMLHttpRequest;
    var XPathEvaluator = jsdom.dom.level3.xpath.XPathEvaluator;

    if (!console.debug) {
        console.debug = process.env.NODE_ENV == 'development' ? console.info : function(){};
    }
}

var og_image = 'http://ogp.me/ns#image';

var oembedPropertyMap = {
    'title': {
        property: 'http://purl.org/dc/elements/1.1/title',
        type: 'literal'
    },
    'author_name': {
        property: 'http://creativecommons.org/ns#attributionName',
        type: 'literal'
    },
    'author_url': {
        property: 'http://creativecommons.org/ns#attributionURL',
        type: 'uri'
    },
};

var ontologyMap = {
    'http://purl.org/dc/elements/1.1/title':            'title',
    'http://purl.org/dc/terms/title':                   'title',
    'http://ogp.me/ns#title':                           'title',

    'http://purl.org/dc/elements/1.1/identifier':       'identifier',
    'http://purl.org/dc/terms/identifier':              'identifier',
    'http://ogp.me/ns#url':                             'identifier',

    'http://purl.org/dc/elements/1.1/creator':          'creator',
    'http://purl.org/dc/terms/creator':                 'creator',
    'http://creativecommons.org/ns#attributionName':    'creator',

    'http://creativecommons.org/ns#attributionURL':     'attributionURL',

    'http://www.w3.org/1999/xhtml/vocab#license':       'license',
    'http://creativecommons.org/ns#license':            'license',
    'http://purl.org/dc/terms/license':                 'license',
};

var defaultRules = {
    source: ['rdfa', 'og', 'oembed'],
};

//
// Parse RDFa out of HTML documents into RDF/JSON, separating the
// pseudo-RDFa OpenGraph statements into a separate graph
//
function JsonRDFaProcessor() {
    this.rdfa = {};
    this.og = {};
    RDFaProcessor.call(this);
}

JsonRDFaProcessor.prototype = new RDFaProcessor();
JsonRDFaProcessor.prototype.constructor = RDFaProcessor;

JsonRDFaProcessor.prototype.addTriple = function(origin, subject, predicate, object) {
    var graph;
    if (/^http:\/\/ogp.me\//.test(predicate)) {
        graph = this.og;
    } else {
        graph = this.rdfa;
    }

    if (!graph.hasOwnProperty(subject)) {
        graph[subject] = {};
    }

    if (!graph[subject].hasOwnProperty(predicate)) {
        graph[subject][predicate] = [];
    }

    var jsonType = object.type === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#object' ? 'uri' : 'literal';
    var jsonObject = {
        type: jsonType,
        value: object.value,
        datatype: jsonType === 'literal' ? object.type : undefined,
        lang: object.language || undefined,
    };

    graph[subject][predicate].push(jsonObject);
};

var addTriple = function(graph, subject, predicate, object) {
    //var object = validateObject(object);

    if (!graph.hasOwnProperty(subject)) {
        graph[subject] = {};
    }

    if (!graph[subject].hasOwnProperty(predicate)) {
        graph[subject][predicate] = [];
    }

    // do not add if triple is already in the graph
    for (var i = 0; i < graph[subject][predicate].length; i++) {
        var o = graph[subject][predicate][i];
        if (o.type === object.type && o.value === object.value && o.lang === object.lang) {
            return;
        }
    }

    graph[subject][predicate].push(object);
};

var getSubjects = function(graph, predicate, object) {
    var subjects = [];
    top:
    for (var s in graph) {
        if (graph.hasOwnProperty(s)) {
            for (var p in graph[s]) {
                if (graph[s].hasOwnProperty(p)) {
                    for (var i = 0; i < graph[s][p].length; i++) {
                        var o = graph[s][p][i];

                        if ((predicate && object && predicate === p && object.type === o.type && object.value === o.value) ||
                            (predicate && !(object) && predicate === p) ||
                            (!(predicate) && object && object === o && object.type === o.type && object.value === o.value) ||
                            (!(predicate) && !(object))) {
                                subjects.push(s);
                                continue top;
                        }
                    }
                }
            }
        }
    }
    return subjects;
}

// Evaluate an XPath expression aExpression against a given DOM node
// or Document object (aNode), returning the results as an array
// thanks wanderingstan at morethanwarm dot mail dot com for the
// initial work.
function evaluateXPath(aNode, aExpr) {
    var xpe = new XPathEvaluator();
    var nsResolver = xpe.createNSResolver(aNode.ownerDocument == null ?
        aNode.documentElement : aNode.ownerDocument.documentElement);
    var result = xpe.evaluate(aExpr, aNode, null, 0, null);
    var found = [];
    var res;
    while (res = result.iterateNext()) {
        found.push(res);
    }
    return found;
}

function Metadata(rdfa, og, oembed, rules, document) {
    var i, j, elements, element, subject, subjects, id, src, selector, sources, arg, objects, main;
    var mainSubject;
    var rewriteMainSubject;
    var metadataGraph;
    var properties = {};

    // look for new main subject, if dictated by rules
    if (rules && rules.rewriteMainSubject) {
        sources = typeof rules.rewriteMainSubject === 'string' ?
            [rules.rewriteMainSubject] : rules.rewriteMainSubject;

        for (i = 0; i < sources.length; i++) {
            if (sources[i].indexOf('oembed:') === 0) {
                // use parameter from oembed data, typically web_page
                arg = sources[i].slice(7);
                rewriteMainSubject = oembed[arg];
                break;
            }
            else if (sources[i].indexOf('rdfa:') === 0) {
                // Find a triple with this predicate
                arg = sources[i].slice(5);
                objects = rdfa[mainSubject][arg];

                if (objects.length === 1 && objects[0]) {
                    rewriteMainSubject = objects[0].value;
                    break;
                }
            }
            else if (sources[i].indexOf('og:') === 0) {
                // Find a triple with this predicate
                arg = sources[i].slice(3);
                // TODO: we don't really need to dig deep into og (it's flat)
                subject = getSubjects(og)[0];
                objects = og[subject][arg];

                if (objects.length === 1 && objects[0]) {
                    rewriteMainSubject = objects[0].value;
                    break;
                }
            }
            else if (sources[i].indexOf('xpath:') === 0) {
                // Find a link with this attribute
                arg = sources[i].slice(6);
                elements = evaluateXPath(document, arg);

                if (elements[0]) {
                    if (elements[0].nodeType == 2) { // attribute
                        rewriteMainSubject = elements[0].value;
                    } else {
                        throw new Error('Unsupported node type returned by XPath expression: ' + arg);
                    }
                    break;
                }
            } else if (sources[i].indexOf('urlregex:') === 0) {
                arg = new RegExp(sources[i].slice(9));
                throw new Error('urlregex support not yet implemented');
            }
        }

        if (!rewriteMainSubject) {
            throw new Error('rewriteMainSubject present in site-rules, but no rewrite candidate found');
        }
    }

    // Discover elements and subjects based on standards, rather than
    // knowledge about a specific page.
    //
    // Image element subjects are located with this heuristic:
    //
    // * If the element has an id, look for '#id'
    // * If the element has a src, look for that URI
    // * If the element src is the unique object of an og:image triplet,
    //   use the subject of the triplet.

    // For now, just look at images.  We can't do this much smarter since
    // we must decode img.src URIs to get a uniform encoding of them.
    elements = document.querySelectorAll('img');

    for (i = 0; i < elements.length; i++) {
        element = elements[i];

        subject = null;
        main = false;

        if (element.id) {
            id = document.documentURI + element.id;
            if (id in rdfa) {
                console.debug('found subject on ID: ' + element.id);
                subject = id;
            }
        }

        if (!subject && element.src) {
            src = decodeURIComponent(element.src); // Get rid of any % escapes
            if (src in rdfa) {
                subject = src;
                console.debug('found subject on src: ' + src);
            }
            // TODO: we don't really need to dig deep into og (it's flat)
            else {
                subjects = getSubjects(og, og_image, {
                    type: 'literal',
                    value: src
                });

                if (subjects[0]) {
                    subject = subjects[0];
                    mainSubject = subject;
                    console.debug('found subject on og:image: ' + subject);
                }
            }
        }

        if (subject && rules && rules.mainElement) {
            for (j = 0; j < rules.mainElement.length; j++) {
                selector = rules.mainElement[j];

                if (element.matchesSelector(selector)) {
                    mainSubject = subject;
                    main = true;

                    console.debug('main subject discovered: ' + mainSubject);
                    break;
                }
            }
        }
    }

    // fill the graph, rewriting main subject if required
    metadataGraph = {};

    // og, rdfa
    [rdfa, og].map(function(graph) {
        for (var s in graph) {
            if (graph.hasOwnProperty(s)) {
                for (var p in graph[s]) {
                    if (graph[s].hasOwnProperty(p)) {
                        for (var i = 0; i < graph[s][p].length; i++) {
                            var o = graph[s][p][i];

                            if (graph === rdfa && s === mainSubject && rewriteMainSubject) {
                                addTriple(metadataGraph, rewriteMainSubject, p, o);
                            }
                            else if (graph === og && rewriteMainSubject) {
                                addTriple(metadataGraph, rewriteMainSubject, p, o);
                            }
                            else {
                                addTriple(metadataGraph, s, p, o);
                            }
                        }
                    }
                }
            }
        }
    });

    // oembed
    if (oembed && rewriteMainSubject) {
        for (var key in oembed) {
            if (oembed.hasOwnProperty(key)) {
                var propertyName = null;
                var propertyType = null;

                if (oembedPropertyMap[key]) {
                    propertyName = oembedPropertyMap[key].property;
                    propertyType = oembedPropertyMap[key].type;
                }

                if (rules.oembed.map && rules.oembed.map[key]) {
                    propertyName = rules.oembed.map[key].property;
                    propertyType = rules.oembed.map[key].type;
                }

                var oembedObject = ({
                    type: propertyType,
                    value: oembed[key],
                    datatype: propertyType === 'literal' ? 'http://www.w3.org/1999/02/22-rdf-syntax-ns#PlainLiteral' : undefined
                });

                if (propertyName) {
                    addTriple(metadataGraph, rewriteMainSubject, propertyName, oembedObject);
                }
            }
        }
    }

    for (var s in metadataGraph) {
        if (metadataGraph.hasOwnProperty(s)) {
            for (var p in metadataGraph[s]) {
                if (metadataGraph[s].hasOwnProperty(p)) {
                    for (var i = 0; i < metadataGraph[s][p].length; i++) {
                        var o = metadataGraph[s][p][i];

                        if (!(s in properties)) {
                            properties[s] = {}
                        } else if (p in ontologyMap) {
                            properties[s][ontologyMap[p]] = o.value;
                        }
                    }
                }
            }
        }
    }

    this.rdfa = rdfa;
    this.og = og;
    this.oembed = oembed;
    this.rules = rules;
    this.document = document;

    this.graph = metadataGraph;
    this.properties = properties;
    this.mainSubject = rewriteMainSubject ? rewriteMainSubject : mainSubject;
}

/**
 * Fetch and parse HTML document from the specified URI,
 * calling callback(error, document) when done.
 */
var _getDocument = function(uri, callback) {
    var result;
    var req = new XMLHttpRequest();

    if (_nodejs) {
        if (uri.match(/^file:/)) {
            jsdom.env({
                file: uri.slice(5),
                done: function(error, window) {
                    window.document.documentURI = uri; // still required for RDFaProcessor
                    callback(error, window.document);
                }
            });
        } else {
            jsdom.env({
                url: uri,
                done: function(error, window) {
                    window.document.documentURI = uri; // still required for RDFaProcessor
                    callback(error, window.document);
                }
            });
        }
    } else {
        req.open('GET', uri, true);

        req.onload = function() {
            //if (_nodejs) {
            //    result = new jsdom.jsdom(req.responseText);
            //    result.documentURI = uri;
            //}
            result = req.responseXML;
            callback(null, result);
        };

        req.onerror = function() {
            callback(new Error('Error opening URI ' + uri), null);
        };

        req.send();
    }
};

/**
 * Get RDFa metadata and oembed endpoint from a document.
 *
 * Returns an object with the following attributes:
 * * rdfa - RDFa metadata as RDF/JSON
 * * og - OpenGraph metadata as RDF/JSON
 * * oembedURL - oembed URL, if discovered
 */
var getMetadataFromDOM = function(document, options, rules, callback) {
    var oembedURL = null;
    var processor = new JsonRDFaProcessor();
    processor.process(document);

    // TODO: support xml
    var oembedLink = document.querySelector('head > link[rel="alternate"][type="application/json+oembed"]');
    if (oembedLink) {
        oembedURL = oembedLink.attributes.href.value;
    }

    callback(null, {
        rdfa: processor.rdfa,
        og: processor.og,
        oembedURL: oembedURL,
    });
};

if (_nodejs) {
    exports.getMetadataFromDOM = getMetadataFromDOM;
}

/**
 * Fetch externally-published metadata, i.e. oembed
 * URI is the actual endpoint URL.
 */
var getPublishedMetadata = function(uri, options, rules, callback) {
    if (_nodejs) {
        var req = new xhr.XMLHttpRequest();
    } else {
        var req = new XMLHttpRequest();
    }

    console.debug('Getting oembed from: ' + uri);
    req.open('GET', uri, true);

    req.onload = function() {
        try {
            var oembed = JSON.parse(req.responseText);
            callback(null, oembed);
        } catch (e) {
            callback(e, null);
        }
    };

    req.onerror = function() {
        callback(new Error('Error getting oEmbed'), null);
    };

    req.send();
};

if (_nodejs) {
    exports.getPublishedMetadata = getPublishedMetadata;
}

var getMetadataImpl = function(document, options, rules, callback) {
    var processDOM;
    var fetchPublished;
    var metadata;

    if (!rules) {
        rules = defaultRules;
    }

    if (options && options.hasOwnProperty('processDOM')) {
        processDOM = options.processDOM;
    }
    else {
        processDOM = getMetadataFromDOM;
    }

    if (options && options.hasOwnProperty('fetchPublished')) {
        fetchPublished = options.fetchPublished;
    }
    else {
        fetchPublished = getPublishedMetadata;
    }

    if (processDOM && document) {
        processDOM(document, options, rules, function(error, documentMetadata) {
            if (error) {
                callback(error, null);
            }
            else {
                if (fetchPublished) {
                    var oembedURL;

                    if (rules.oembed && rules.oembed.endpoint) {
                        // use site-specific oembed endpoint + document URL
                        var params = '?format=json&url=' + encodeURIComponent(document.documentURI);
                        oembedURL = rules.oembed.endpoint + params;
                    }
                    else {
                        // use discovered oembed URL
                        oembedURL = documentMetadata.oembedURL;
                    }

                    if (oembedURL) {
                        fetchPublished(oembedURL, options, rules, function(error, publishedMetadata) {
                            if (error) {
                                callback(error, null);
                            }
                            else {
                                // have rdfa, og(?), oembed
                                metadata = new Metadata(
                                    documentMetadata.rdfa,
                                    documentMetadata.og,
                                    publishedMetadata,
                                    rules,
                                    document
                                );
                                callback(null, metadata);
                            }
                        });
                    }
                    else {
                        // no oembedURL, have rdfa, og(?)
                        metadata = new Metadata(
                            documentMetadata.rdfa,
                            documentMetadata.og,
                            null,
                            rules,
                            document
                        );
                        callback(null, metadata);
                    }
                }
                else {
                    // no fetchPublished, have rdfa, og(?)
                    metadata = new Metadata(
                        documentMetadata.rdfa,
                        documentMetadata.og,
                        null,
                        rules,
                        document
                    );
                    callback(null, metadata);
                }
            }
        });
    }
    else if (fetchPublished) {
        if (rules.oembed && rules.oembed.endpoint) {
            // TODO: where do we get the document URI from?
            fetchPublished(rules.oembed.endpoint, options, rules, function(error, publishedMetadata) {
                if (error) {
                    callback(error, null);
                }
                else {
                    // have oembed
                    metadata = new Metadata(
                        null,
                        null,
                        publishedMetadata,
                        rules,
                        document
                    );
                    callback(null, metadata);
                }
            });
        }
        else {
            callback(new Error('no oembed endpoint in rules'), null);
        }
    }
};

/**
 * Get all available metadata for a given source (uri or document)
 * and call callback(error, result) when done.
 *
 * Arguments:
 * source - URI or document (can be null)
 * options - container for optional override functions for getting published or RDFa metadata
 *   - processDOM: function(uri, options, rules, callback)
 *       Called by getMetadata to fetch metadata from DOM for a given URI.
 *       On success callback should return an object in the form of {rdfa:..., og:..., oembedURL:...}
 *       Default: getMetadataFromDOM().
 *   - fetchPublished: function(uri, options, rules, callback)
 *       Called by getMetadata to fetch published metadata.
 *       Default: getPublishedMetadata().
 * rules - site-specific rules for subject mangling and fetching oEmbed.
 * callback - function(error, metadata) to be called on success or failure.
 */
var getMetadata = function(source, options, rules, callback) {
    if (typeof source === 'string') {
        _getDocument(source, function(error, doc) {
            if (error) {
                callback(error, null);
            }
            else {
                getMetadataImpl(doc, options, rules, callback);
            }
        });
    }
    else {
        getMetadataImpl(document, options, rules, callback);
    }
};

if (_nodejs) {
    exports.getMetadata = getMetadata;
}