rangy.createModule("TextRange", function(api, module) {
    api.requireModules( ["WrappedSelection"] );

    var UNDEF = "undefined";
    var CHARACTER = "character", WORD = "word";
    var dom = api.dom, util = api.util, DomPosition = dom.DomPosition;
    var extend = util.extend;

    var log = log4javascript.getLogger("rangy.textrange");

    var spacesRegex = /^[ \t\f\r\n]+$/;
    var spacesMinusLineBreaksRegex = /^[ \t\f\r]+$/;
    var allWhiteSpaceRegex = /^[\t-\r \u0085\u00A0\u1680\u180E\u2000-\u200B\u2028\u2029\u202F\u205F\u3000]+$/;
    var nonLineBreakWhiteSpaceRegex = /^[\t \u00A0\u1680\u180E\u2000-\u200B\u202F\u205F\u3000]+$/;
    var lineBreakRegex = /^[\n-\r\u0085\u2028\u2029]$/;

    var defaultLanguage = "en";

    var isDirectionBackward = api.Selection.isDirectionBackward;

    // Properties representing whether trailing spaces inside blocks are completely collapsed (as they are in WebKit,
    // but not other browsers). Also test whether trailing spaces before <br> elements are collapsed.
    var trailingSpaceInBlockCollapses = false;
    var trailingSpaceBeforeBrCollapses = false;
    var trailingSpaceBeforeLineBreakInPreLineCollapses = true;

    /*----------------------------------------------------------------------------------------------------------------*/

    // This function must create word and non-word tokens for the whole of the text supplied to it
    function defaultTokenizer(chars, wordOptions) {
        var word = chars.join(""), result, tokens = [];

        function createTokenFromRange(start, end, isWord) {
            var tokenChars = chars.slice(start, end);
            var token = {
                isWord: isWord,
                chars: tokenChars,
                toString: function() {
                    return tokenChars.join("");
                }
            };
            for (var i = 0, len = tokenChars.length; i < len; ++i) {
                tokenChars[i].token = token;
            }
            tokens.push(token);
        }

        // Match words and mark characters
        var lastWordEnd = 0, wordStart, wordEnd;
        while ( (result = wordOptions.wordRegex.exec(word)) ) {
            wordStart = result.index;
            wordEnd = wordStart + result[0].length;

            // Create token for non-word characters preceding this word
            if (wordStart > lastWordEnd) {
                createTokenFromRange(lastWordEnd, wordStart, false);
            }

            // Get trailing space characters for word
            if (wordOptions.includeTrailingSpace) {
                while (nonLineBreakWhiteSpaceRegex.test(chars[wordEnd])) {
                    ++wordEnd;
                }
            }
            createTokenFromRange(wordStart, wordEnd, true);
            lastWordEnd = wordEnd;
        }

        // Create token for trailing non-word characters, if any exist
        if (lastWordEnd < chars.length) {
            createTokenFromRange(lastWordEnd, chars.length, false);
        }

        return tokens;
    }

    var defaultCharacterOptions = {
        includeBlockContentTrailingSpace: true,
        includeSpaceBeforeBr: true,
        includePreLineTrailingSpace: true
    };

    function createCharacterOptions() {

    }

    var defaultWordOptions = {
        "en": {
            wordRegex: /[a-z0-9]+('[a-z0-9]+)*/gi,
            includeTrailingSpace: false,
            tokenizer: defaultTokenizer
        }
    };

    function createOptions(optionsParam, defaults) {
        if (!optionsParam) {
            return defaults;
        } else {
            var options = {};
            extend(options, defaults);
            extend(options, optionsParam);
            return options;
        }
    }

    function createWordOptions(options) {
        var lang, defaults;
        if (!options) {
            return defaultWordOptions[defaultLanguage];
        } else {
            lang = options.language || defaultLanguage;
            defaults = {};
            extend(defaults, defaultWordOptions[lang] || defaultWordOptions[defaultLanguage]);
            extend(defaults, options);
            return defaults;
        }
    }

    var defaultFindOptions = {
        caseSensitive: false,
        withinRange: null,
        wholeWordsOnly: false,
        wrap: false,
        direction: "forward",
        wordOptions: null,
        characterOptions: null
    };

    var defaultMoveOptions = {
        wordOptions: null,
        characterOptions: null
    };

    var defaultExpandOptions = {
        wordOptions: null,
        characterOptions: null,
        trim: false,
        trimStart: true,
        trimEnd: true
    };

    var defaultWordIteratorOptions = {
        wordOptions: null,
        characterOptions: null,
        direction: "forward"
    };

    /*----------------------------------------------------------------------------------------------------------------*/

    /* DOM utility functions */


    var getComputedStyleProperty;
    if (typeof window.getComputedStyle != UNDEF) {
        getComputedStyleProperty = function(el, propName) {
            return dom.getWindow(el).getComputedStyle(el, null)[propName];
        };
    } else if (typeof document.documentElement.currentStyle != UNDEF) {
        getComputedStyleProperty = function(el, propName) {
            return el.currentStyle[propName];
        };
    } else {
        module.fail("No means of obtaining computed style properties found");
    }


    /*
    functions to wrap:

    - isWhitespaceNode
    - isCollapsedWhitespaceNode?
    - getComputedDisplay
    - isCollapsedNode
    - isIgnoredNode

     */

    function createCachingFunction(func, metadataKey) {
        return function() {
            //if ()
        }
    }

    /*----------------------------------------------------------------------------------------------------------------*/

    // Create cachable versions of DOM functions

    // Test for old IE's incorrect display properties
    var tableCssDisplayBlock;
    (function() {
        var table = document.createElement("table");
        document.body.appendChild(table);
        tableCssDisplayBlock = (getComputedStyleProperty(table, "display") == "block");
        document.body.removeChild(table);
    })();

    api.features.tableCssDisplayBlock = tableCssDisplayBlock;

    var defaultDisplayValueForTag = {
        table: "table",
        caption: "table-caption",
        colgroup: "table-column-group",
        col: "table-column",
        thead: "table-header-group",
        tbody: "table-row-group",
        tfoot: "table-footer-group",
        tr: "table-row",
        td: "table-cell",
        th: "table-cell"
    };

    // Corrects IE's "block" value for table-related elements
    function getComputedDisplay(el, win) {
        var display = getComputedStyleProperty(el, "display", win);
        var tagName = el.tagName.toLowerCase();
        return (display == "block"
            && tableCssDisplayBlock
            && defaultDisplayValueForTag.hasOwnProperty(tagName))
            ? defaultDisplayValueForTag[tagName] : display;
    }

    function isHidden(node) {
        var ancestors = getAncestorsAndSelf(node);
        for (var i = 0, len = ancestors.length; i < len; ++i) {
            if (ancestors[i].nodeType == 1 && getComputedDisplay(ancestors[i]) == "none") {
                return true;
            }
        }

        return false;
    }

    function isVisibilityHiddenTextNode(textNode) {
        var el;
        return textNode.nodeType == 3
            && (el = textNode.parentNode)
            && getComputedStyleProperty(el, "visibility") == "hidden";
    }

    /*----------------------------------------------------------------------------------------------------------------*/


    // "A block node is either an Element whose "display" property does not have
    // resolved value "inline" or "inline-block" or "inline-table" or "none", or a
    // Document, or a DocumentFragment."
    function isBlockNode(node) {
        return node
            && ((node.nodeType == 1 && !/^(inline(-block|-table)?|none)$/.test(getComputedDisplay(node)))
            || node.nodeType == 9 || node.nodeType == 11);
    }

    function getLastDescendantOrSelf(node) {
        var lastChild = node.lastChild;
        return lastChild ? getLastDescendantOrSelf(lastChild) : node;
    }

    function containsPositions(node) {
        return dom.isCharacterDataNode(node)
            || !/^(area|base|basefont|br|col|frame|hr|img|input|isindex|link|meta|param)$/i.test(node.nodeName);
    }

    function getAncestors(node) {
        var ancestors = [];
        while (node.parentNode) {
            ancestors.unshift(node.parentNode);
            node = node.parentNode;
        }
        return ancestors;
    }

    function getAncestorsAndSelf(node) {
        return getAncestors(node).concat([node]);
    }

    // Opera 11 puts HTML elements in the null namespace, it seems, and IE 7 has undefined namespaceURI
    function isHtmlNode(node) {
        var ns;
        return typeof (ns = node.namespaceURI) == UNDEF || (ns === null || ns == "http://www.w3.org/1999/xhtml");
    }

    function isHtmlElement(node, tagNames) {
        if (!node || node.nodeType != 1 || !isHtmlNode(node)) {
            return false;
        }
        switch (typeof tagNames) {
            case "string":
                return node.tagName.toLowerCase() == tagNames.toLowerCase();
            case "object":
                return new RegExp("^(" + tagNames.join("|S") + ")$", "i").test(node.tagName);
            default:
                return true;
        }
    }

    function nextNodeDescendants(node) {
        while (node && !node.nextSibling) {
            node = node.parentNode;
        }
        if (!node) {
            return null;
        }
        return node.nextSibling;
    }

    function nextNode(node, excludeChildren) {
        if (!excludeChildren && node.hasChildNodes()) {
            return node.firstChild;
        }
        return nextNodeDescendants(node);
    }

    function previousNode(node) {
        var previous = node.previousSibling;
        if (previous) {
            node = previous;
            while (node.hasChildNodes()) {
                node = node.lastChild;
            }
            return node;
        }
        var parent = node.parentNode;
        if (parent && parent.nodeType == 1) {
            return parent;
        }
        return null;
    }



    // Adpated from Aryeh's code.
    // "A whitespace node is either a Text node whose data is the empty string; or
    // a Text node whose data consists only of one or more tabs (0x0009), line
    // feeds (0x000A), carriage returns (0x000D), and/or spaces (0x0020), and whose
    // parent is an Element whose resolved value for "white-space" is "normal" or
    // "nowrap"; or a Text node whose data consists only of one or more tabs
    // (0x0009), carriage returns (0x000D), and/or spaces (0x0020), and whose
    // parent is an Element whose resolved value for "white-space" is "pre-line"."
    function isWhitespaceNode(node) {
        if (!node || node.nodeType != 3) {
            return false;
        }
        var text = node.data;
        if (text === "") {
            return true;
        }
        var parent = node.parentNode;
        if (!parent || parent.nodeType != 1) {
            return false;
        }
        var computedWhiteSpace = getComputedStyleProperty(node.parentNode, "whiteSpace");

        return (/^[\t\n\r ]+$/.test(text) && /^(normal|nowrap)$/.test(computedWhiteSpace))
            || (/^[\t\r ]+$/.test(text) && computedWhiteSpace == "pre-line");
    }

    // Adpated from Aryeh's code.
    // "node is a collapsed whitespace node if the following algorithm returns
    // true:"
    function isCollapsedWhitespaceNode(node) {
        // "If node's data is the empty string, return true."
        if (node.data === "") {
            return true;
        }

        // "If node is not a whitespace node, return false."
        if (!isWhitespaceNode(node)) {
            return false;
        }

        // "Let ancestor be node's parent."
        var ancestor = node.parentNode;

        // "If ancestor is null, return true."
        if (!ancestor) {
            return true;
        }

        // "If the "display" property of some ancestor of node has resolved value "none", return true."
        if (isHidden(node)) {
            return true;
        }

        return false;
    }

    function isCollapsedNode(node) {
        var type = node.nodeType;
        //log.debug("isCollapsedNode", isHidden(node), /^(script|style)$/i.test(node.nodeName), isCollapsedWhitespaceNode(node));
        return type == 7 /* PROCESSING_INSTRUCTION */
            || type == 8 /* COMMENT */
            || isHidden(node)
            || /^(script|style)$/i.test(node.nodeName)
            || isVisibilityHiddenTextNode(node)
            || isCollapsedWhitespaceNode(node);
    }

    function isIgnoredNode(node, win) {
        var type = node.nodeType;
        return type == 7 /* PROCESSING_INSTRUCTION */
            || type == 8 /* COMMENT */
            || (type == 1 && getComputedDisplay(node, win) == "none");
    }

    /*----------------------------------------------------------------------------------------------------------------*/

    // Possibly overengineered caching system to prevent repeated DOM calls slowing everything down

    function Cache() {
        this.store = {};
    }

    Cache.prototype = {
        get: function(key) {
            return this.store.hasOwnProperty(key) ? this.store[key] : null;
        },

        set: function(key, value) {
            return this.store[key] = value;
        }
    };

    function createCachingGetter(methodName, func, objProperty) {
        return function(args) {
            var cache = this.cache;
            if (cache.hasOwnProperty(methodName)) {
                return cache[methodName];
            } else {
                var value = func.call(this, objProperty ? this[objProperty] : this, args);
                cache[methodName] = value;
                return value;
            }
        };
    }

    /*----------------------------------------------------------------------------------------------------------------*/

    function NodeWrapper(node, transaction) {
        this.node = node;
        this.transaction = transaction;
        this.cache = new Cache();
        this.positions = new Cache();
    }

    var nodeProto = {
        getPosition: function(offset) {
            var positions = this.positions;
            return positions.get(offset) || positions.set(offset, new Position(this, offset));
        },

        toString: function() {
            return "[NodeWrapper(" + dom.inspectNode(this.node) + ")]";
        }
    };

    NodeWrapper.prototype = nodeProto;

    var EMPTY = "EMPTY",
        NON_SPACE = "NON_SPACE",
        UNCOLLAPSIBLE_SPACE = "UNCOLLAPSIBLE_SPACE",
        COLLAPSIBLE_SPACE = "COLLAPSIBLE_SPACE",
        TRAILING_SPACE_IN_BLOCK = "TRAILING_SPACE_IN_BLOCK",
        TRAILING_SPACE_BEFORE_BR = "TRAILING_SPACE_BEFORE_BR",
        PRE_LINE_TRAILING_SPACE_BEFORE_LINE_BREAK = "PRE_LINE_TRAILING_SPACE_BEFORE_LINE_BREAK";


    extend(nodeProto, {
        isCharacterDataNode: createCachingGetter("isCharacterDataNode", dom.isCharacterDataNode, "node"),
        getNodeIndex: createCachingGetter("nodeIndex", dom.getNodeIndex, "node"),
        getLength: createCachingGetter("nodeLength", dom.getNodeLength, "node"),
        containsPositions: createCachingGetter("containsPositions", containsPositions, "node"),
        isWhitespace: createCachingGetter("isWhitespace", isWhitespaceNode, "node"),
        isCollapsedWhitespace: createCachingGetter("isCollapsedWhitespace", isCollapsedWhitespaceNode, "node"),
        getComputedDisplay: createCachingGetter("computedDisplay", getComputedDisplay, "node"),
        isCollapsed: createCachingGetter("collapsed", isCollapsedNode, "node"),
        isIgnored: createCachingGetter("ignored", isIgnoredNode, "node"),
        next: createCachingGetter("nextPos", nextNode, "node"),
        previous: createCachingGetter("previous", previousNode, "node"),

        getTextNodeInfo: createCachingGetter("textNodeInfo", function(textNode) {
            log.debug("getTextNodeInfo for " + textNode.data);
            var spaceRegex = null, collapseSpaces = false;
            var cssWhitespace = getComputedStyleProperty(textNode.parentNode, "whiteSpace");
            var preLine = (cssWhitespace == "pre-line");
            if (preLine) {
                spaceRegex = spacesMinusLineBreaksRegex;
                collapseSpaces = true;
            } else if (cssWhitespace == "normal" || cssWhitespace == "nowrap") {
                spaceRegex = spacesRegex;
                collapseSpaces = true;
            }

            return {
                node: textNode,
                text: textNode.data,
                spaceRegex: spaceRegex,
                collapseSpaces: collapseSpaces,
                preLine: preLine
            };
        }, "node"),

        hasInnerText: createCachingGetter("hasInnerText", function(el, backward) {
            var transaction = this.transaction;
            var posAfterEl = transaction.getPosition(el.parentNode, this.getNodeIndex() + 1);
            var firstPosInEl = transaction.getPosition(el, 0);

            var pos = backward ? posAfterEl : firstPosInEl;
            var endPos = backward ? firstPosInEl : posAfterEl;

            /*
             <body><p>X  </p><p>Y</p></body>

             Positions:

             body:0:""
             p:0:""
             text:0:""
             text:1:"X"
             text:2:TRAILING_SPACE_IN_BLOCK
             text:3:COLLAPSED_SPACE
             p:1:""
             body:1:"\n"
             p:0:""
             text:0:""
             text:1:"Y"

             A character is a TRAILING_SPACE_IN_BLOCK iff:

             - There is no uncollapsed character after it within the visible containing block element

             A character is a TRAILING_SPACE_BEFORE_BR iff:

             - There is no uncollapsed character after it preceding a <br> element

             An element has inner text iff

             - It is not hidden
             - It contains an uncollapsed character

             All trailing spaces (pre-line, before <br>, end of block) require definite non-empty characters to render.
             */

            while (pos !== endPos) {
                pos.prepopulateChar();
                if (pos.isDefinitelyNonEmpty()) {
                    return true;
                }
                pos = backward ? pos.previousVisible() : pos.nextVisible();
            }

            return false;
        }, "node"),

        getTrailingSpace: createCachingGetter("trailingSpace", function(el) {
            if (el.tagName.toLowerCase() == "br") {
                return "";
            } else {
                switch (this.getComputedDisplay()) {
                    case "inline":
                        var child = el.lastChild;
                        while (child) {
                            if (!isIgnoredNode(child)) {
                                return (child.nodeType == 1) ? this.transaction.getNodeWrapper(child).getTrailingSpace() : "";
                            }
                            child = child.previousSibling;
                        }
                        break;
                    case "inline-block":
                    case "inline-table":
                    case "none":
                    case "table-column":
                    case "table-column-group":
                        break;
                    case "table-cell":
                        return "\t";
                    default:
                        return this.hasInnerText(true) ? "\n" : "";
                }
            }
            return "";
        }, "node"),

        getLeadingSpace: createCachingGetter("leadingSpace", function(el) {
            switch (this.getComputedDisplay()) {
                case "inline":
                case "inline-block":
                case "inline-table":
                case "none":
                case "table-column":
                case "table-column-group":
                case "table-cell":
                    break;
                default:
                    return this.hasInnerText(false) ? "\n" : "";
            }
            return "";
        }, "node")
    });

    /*----------------------------------------------------------------------------------------------------------------*/


    function Position(nodeWrapper, offset) {
        this.offset = offset;
        this.nodeWrapper = nodeWrapper;
        this.node = nodeWrapper.node;
        this.transaction = nodeWrapper.transaction;
        this.cache = new Cache();
    }

    function inspectPosition() {
        return "[Position(" + dom.inspectNode(this.node) + ":" + this.offset + ")]";
    }

    var positionProto = {
        character: "",
        characterType: EMPTY,
        isBr: false,

        /*
        This method:
        - Fully populates positions that have characters that can be determined independently of any other characters.
        - Populates most types of space positions with a provisional character. The character is finalized later.
         */
        prepopulateChar: function() {
            var pos = this;
            if (!pos.prepopulatedChar) {
                var node = pos.node, offset = pos.offset;
                log.debug("prepopulateChar " + pos.inspect());
                var visibleChar = "", charType = EMPTY;
                var finalizedChar = false;
                if (offset > 0) {
                    if (node.nodeType == 3) {
                        var text = node.data;
                        var textChar = text.charAt(offset - 1);
                        log.debug("Got char '" + textChar + "' in data '" + text + "'");

                        var nodeInfo = pos.nodeWrapper.getTextNodeInfo();
                        var spaceRegex = nodeInfo.spaceRegex;
                        if (nodeInfo.collapseSpaces) {
                            if (spaceRegex.test(textChar)) {
                                // "If the character at position is from set, append a single space (U+0020) to newdata and advance
                                // position until the character at position is not from set."

                                // We also need to check for the case where we're in a pre-line and we have a space preceding a
                                // line break, because such spaces are collapsed in some browsers
                                if (offset > 1 && spaceRegex.test(text.charAt(offset - 2))) {
                                    log.debug("Character is a collapsible space preceded by another collapsible space, therefore empty");
                                } else if (nodeInfo.preLine && text.charAt(offset) === "\n") {
                                    log.debug("Character is a collapsible space which is followed by a line break in a pre-line element, skipping");
                                    visibleChar = " ";
                                    charType = PRE_LINE_TRAILING_SPACE_BEFORE_LINE_BREAK;
                                } else {
                                    log.debug("Character is a collapsible space not preceded by another collapsible space, adding");
                                    visibleChar = " ";
                                    charType = COLLAPSIBLE_SPACE;
                                }
                            } else {
                                log.debug("Character is not a space, adding");
                                visibleChar = textChar;
                                charType = NON_SPACE;
                                finalizedChar = true;
                            }
                        } else {
                            log.debug("Spaces are not collapsible, so adding");
                            visibleChar = textChar;
                            charType = UNCOLLAPSIBLE_SPACE;
                            finalizedChar = true;
                        }
                    } else {
                        var nodePassed = node.childNodes[offset - 1];
                        if (nodePassed && nodePassed.nodeType == 1 && !isCollapsedNode(nodePassed)) {
                            if (nodePassed.tagName.toLowerCase() == "br") {
                                log.debug("Node is br");
                                visibleChar = "\n";
                                pos.isBr = true;
                                charType = UNCOLLAPSIBLE_SPACE;
                                finalizedChar = true;
                            } else {
                                log.debug("Unresolved trailing space for node " + dom.inspectNode(nodePassed) + ". Will resolve this later if necessary.");
                                pos.checkForTrailingSpace = true;
                            }
                        }

                        // Check the leading space of the next node for the case when a block element follows an inline
                        // element or text node. In that case, there is an implied line break between the two nodes.
                        if (!visibleChar) {
                            var nextNode = node.childNodes[offset];
                            if (nextNode && nextNode.nodeType == 1 && !isCollapsedNode(nextNode)) {
                                log.debug("Unresolved leading space for node " + dom.inspectNode(nextNode) + ". Will resolve this later if necessary.");
                                pos.checkForLeadingSpace = true;
                            }
                        }
                    }
                }

                pos.prepopulatedChar = true;
                pos.character = visibleChar;
                pos.characterType = charType;
                pos.isCharFinalized = finalizedChar;
            }
        },

        isDefinitelyNonEmpty: function() {
            var charType = this.characterType;
            return charType == NON_SPACE || charType == UNCOLLAPSIBLE_SPACE;
        },

        // Resolve leading and trailing spaces, which may involve prepopulating other positions
        resolveLeadingAndTrailingSpaces: function() {
            if (!this.prepopulatedChar) {
                this.prepopulateChar();
            }
            if (this.checkForTrailingSpace) {
                var trailingSpace = this.nodeWrapper.getTrailingSpace();
                if (trailingSpace) {
                    this.isTrailingSpace = true;
                    this.character = trailingSpace;
                    this.characterType = COLLAPSIBLE_SPACE;
                }
                this.checkForTrailingSpace = false;
            }
            if (this.checkForLeadingSpace) {
                var leadingSpace = this.nodeWrapper.getLeadingSpace();
                log.debug("resolveLeadingAndTrailingSpaces checking for leading space on " + this.inspect() + ", got '" + leadingSpace + "'");
                if (leadingSpace) {
                    this.isLeadingSpace = true;
                    this.character = leadingSpace;
                    this.characterType = COLLAPSIBLE_SPACE;
                }
                this.checkForLeadingSpace = false;
            }
        },
        
        getPrecedingUncollapsedPosition: function() {
            log.group("getPrecedingUncollapsedPosition " + this.inspect());
            var pos = this;
            while ( (pos = pos.previousVisible()) ) {
                pos.resolveLeadingAndTrailingSpaces();
                log.debug("getPrecedingUncollapsedPosition looking at " + pos.inspect() + " which has type " + pos.characterType);
                if (pos.characterType != EMPTY) {
                    log.groupEnd();
                    return pos;
                }
            }

            log.groupEnd();
            return null;
            
/*
            // First, track back until we find a definitely non-empty position, or the first position in the document 
            var pos = this, nextPos, startPos;
            while (true) {
                nextPos = pos.previousVisible();
                if (!nextPos) {
                    startPos = pos;
                    break;
                }
                if (nextPos.isDefinitelyNonEmpty()) {
                    startPos = nextPos;
                    break;
                }
                pos = nextPos;
            }
*/
        },

        getCharacter: function(characterOptions) {
            var character = "";
            
            log.group("getCharacter called on " + this.inspect());
            
            this.resolveLeadingAndTrailingSpaces();
            var collapsible = (this.characterType == COLLAPSIBLE_SPACE);
            log.info("getCharacter initial character is '" + this.character + "'", collapsible);

            if (this.isCharFinalized) {
                character = this.character;
            } else {
/*
                var previousPos = this.previousVisible(), nextPos;
                if (previousPos) {
                    previousPos.resolveLeadingAndTrailingSpaces();
                }
*/
                
                var nextPos, previousPos;

                // Disallow a collapsible space that follows a trailing space or line break, or is the first character
                if (this.character === " " && collapsible &&
                        ( !(previousPos = this.getPrecedingUncollapsedPosition()) || previousPos.isTrailingSpace || previousPos.character == "\n")) {
                    log.info("Preceding character is a trailing space or non-existent or follows a line break and current possible character is a collapsible space, so space is collapsed");
                }

                // Disallow a collapsible space that is followed by a line break or is the last character
                else if (collapsible) {
                    nextPos = this.nextUncollapsed();
                    log.debug("nextPos: " + nextPos.inspect());
                    if (nextPos) {
                        if (nextPos.character === "\n") {
                            if (this.type == TRAILING_SPACE_BEFORE_BR && nextPos.isBr && !characterOptions.includeSpaceBeforeBr) {
                                log.debug("Character is a space which is followed by a br. Policy from options is to collapse.");
                            } else if (this.type == TRAILING_SPACE_IN_BLOCK && nextPos.isTrailingSpace && !characterOptions.includeBlockContentTrailingSpace) {
                                log.debug("Character is a space which is the final character in a block. Policy from options is to collapse.");
                            } else if (this.type == PRE_LINE_TRAILING_SPACE_BEFORE_LINE_BREAK && nextPos.type == NON_SPACE && !characterOptions.includePreLineTrailingSpace) {
                                log.debug("Character is a space which is followed by a line break in a pre-line element. Policy from options is to collapse.");
                            } else {
                                log.debug("Collapsible space followed by a line break is being included.");
                                character = " ";
                            }
                        } else {
                            log.debug("Character is a collapsible space or line break that has not been disallowed");
                            character = this.character;
                        }
                    } else {
                        log.debug("Character is a space which is followed by nothing, so collapsing");
                    }
                }

                // Collapse a br element that is followed by a trailing space
                else if (this.character === "\n" && !collapsible &&
                        (!(nextPos = this.nextUncollapsed()) || nextPos.isTrailingSpace)) {
                    log.debug("Character is a br which is followed by a trailing space or nothing. This is always collapsed.");
                }
            }
            
            log.debug("getCharacter returning '" + character + "' for pos " + this.inspect())
            log.groupEnd();
            
            this.character = character;

            return character;
        },

        equals: function(pos) {
            return !!pos && this.node === pos.node && this.offset === pos.offset;
        },

        inspect: inspectPosition,

        toString: function() {
            return this.character;
        }
    };

    Position.prototype = positionProto;

    extend(positionProto, {
        next: createCachingGetter("nextPos", function(pos) {
            var nodeWrapper = pos.nodeWrapper, node = pos.node, offset = pos.offset, transaction = nodeWrapper.transaction;
            if (!node) {
                return null;
            }
            var nextNode, nextOffset, child;
            if (offset == nodeWrapper.getLength()) {
                // Move onto the next node
                nextNode = node.parentNode;
                nextOffset = nextNode ? nodeWrapper.getNodeIndex() + 1 : 0;
            } else {
                if (nodeWrapper.isCharacterDataNode()) {
                    nextNode = node;
                    nextOffset = offset + 1;
                } else {
                    child = node.childNodes[offset];
                    // Go into the children next, if children there are
                    if (transaction.getNodeWrapper(child).containsPositions()) {
                        nextNode = child;
                        nextOffset = 0;
                    } else {
                        nextNode = node;
                        nextOffset = offset + 1;
                    }
                }
            }

            return nextNode ? transaction.getPosition(nextNode, nextOffset) : null;
        }),

        previous: createCachingGetter("previous", function(pos) {
            var nodeWrapper = pos.nodeWrapper, node = pos.node, offset = pos.offset, transaction = nodeWrapper.transaction;
            var previousNode, previousOffset, child;
            if (offset == 0) {
                previousNode = node.parentNode;
                previousOffset = previousNode ? nodeWrapper.getNodeIndex() : 0;
            } else {
                if (nodeWrapper.isCharacterDataNode()) {
                    previousNode = node;
                    previousOffset = offset - 1;
                } else {
                    child = node.childNodes[offset - 1];
                    // Go into the children next, if children there are
                    if (transaction.getNodeWrapper(child).containsPositions()) {
                        previousNode = child;
                        previousOffset = dom.getNodeLength(child);
                    } else {
                        previousNode = node;
                        previousOffset = offset - 1;
                    }
                }
            }
            return previousNode ? transaction.getPosition(previousNode, previousOffset) : null;
        }),

        /*
         Next and previous position moving functions that filter out

         - Hidden (CSS visibility/display) elements
         - Script and style elements
         - collapsed whitespace characters??? NO.
         */
        nextVisible: createCachingGetter("nextVisible", function(pos) {
            var next = pos.next();
            if (!next) {
                return null;
            }
            var nodeWrapper = next.nodeWrapper, node = next.node;
            var newPos = next;
            if (nodeWrapper.isCollapsed()) {
                // We're skipping this node and all its descendants
                newPos = nodeWrapper.transaction.getPosition(node.parentNode, nodeWrapper.getNodeIndex() + 1);
            }
            return newPos;
        }),

        nextUncollapsed: createCachingGetter("nextUncollapsed", function(pos) {
            log.group("nextUncollapsed " + this.inspect());
            var nextPos = pos;
            while ( (nextPos = nextPos.nextVisible()) ) {
                nextPos.resolveLeadingAndTrailingSpaces();
                if (nextPos.character !== "") {
                    log.groupEnd();
                    return nextPos;
                }
            }
            log.groupEnd();
            return null;
        }),

        previousVisible: createCachingGetter("previousVisible", function(pos) {
            var previous = pos.previous();
            if (!previous) {
                return null;
            }
            var nodeWrapper = previous.nodeWrapper, node = previous.node;
            var newPos = previous;
            if (nodeWrapper.isCollapsed()) {
                // We're skipping this node and all its descendants
                newPos = nodeWrapper.transaction.getPosition(node.parentNode, nodeWrapper.getNodeIndex());
            }
            return newPos;
        })
    });

    /*----------------------------------------------------------------------------------------------------------------*/

    var currentTransaction = null;

    var Transaction = (function() {
        function createWrapperCache(nodeProperty) {
            var cache = new Cache();

            return {
                get: function(node) {
                    var wrappersByProperty = cache.get(node[nodeProperty]);
                    if (wrappersByProperty) {
                        for (var i = 0, wrapper; wrapper = wrappersByProperty[i++]; ) {
                            if (wrapper.node === node) {
                                return wrapper;
                            }
                        }
                    }
                    return null;
                },

                set: function(nodeWrapper) {
                    var property = nodeWrapper.node[nodeProperty];
                    var wrappersByProperty = cache.get(property) || cache.set(property, []);
                    wrappersByProperty.push(nodeWrapper);
                }
            };
        }

        var uniqueIDSupported = util.isHostProperty(document.documentElement, "uniqueID");

        function Transaction() {
            this.initCaches();
        }

        Transaction.prototype = {
            initCaches: function() {
                this.elementCache = uniqueIDSupported ? (function() {
                    var elementsCache = new Cache();

                    return {
                        get: function(el) {
                            return elementsCache.get(el.uniqueID);
                        },

                        set: function(elWrapper) {
                            elementsCache.set(elWrapper.node.uniqueID, elWrapper);
                        }
                    };
                })() : createWrapperCache("tagName");

                // Store text nodes keyed by data, although we may need to truncate this
                this.textNodeCache = createWrapperCache("data");
                this.otherNodeCache = createWrapperCache("nodeName");
            },

            getNodeWrapper: function(node) {
                var wrapperCache;
                switch (node.nodeType) {
                    case 1:
                        wrapperCache = this.elementCache;
                        break;
                    case 3:
                        wrapperCache = this.textNodeCache;
                        break;
                    default:
                        wrapperCache = this.otherNodeCache;
                        break;
                }

                var wrapper = wrapperCache.get(node);
                if (!wrapper) {
                    wrapper = new NodeWrapper(node, this);
                    wrapperCache.set(wrapper);
                }
                return wrapper;
            },

            getPosition: function(node, offset) {
                return this.getNodeWrapper(node).getPosition(offset);
            },

            getRangeBoundaryPosition: function(range, isStart) {
                var prefix = isStart ? "start" : "end";
                return this.getPosition(range[prefix + "Container"], range[prefix + "Offset"]);
            },

            detach: function() {
                this.elementCache = this.textNodeCache = this.otherNodeCache = null;
            }
        };

        return Transaction;
    })();

    /*----------------------------------------------------------------------------------------------------------------*/

    function startTransaction() {
        endTransaction();
        return (currentTransaction = new Transaction());
    }

    function getTransaction() {
        return currentTransaction || startTransaction();
    }

    function endTransaction() {
        if (currentTransaction) {
            currentTransaction.detach();
        }
        currentTransaction = null;
    }

    /*----------------------------------------------------------------------------------------------------------------*/

    // Extensions to the rangy.dom utility object

    extend(dom, {
        nextNode: nextNode,
        previousNode: previousNode
    });

    /*----------------------------------------------------------------------------------------------------------------*/

    function createCharacterIterator(startPos, backward, endPos, characterOptions) {
        log.info("createCharacterIterator called backwards " + backward + " and with endPos " + (endPos ? endPos.inspect() : ""));

        // Adjust the end position to ensure that it is actually reached
        if (endPos) {
            if (backward) {
                if (isCollapsedNode(endPos.node)) {
                    endPos = startPos.previousVisible();
                }
            } else {
                if (isCollapsedNode(endPos.node)) {
                    endPos = endPos.nextVisible();
                }
            }
        }
        log.info("endPos now " + (endPos ? endPos.inspect() : ""));

        var pos = startPos, finished = false;

        function next() {
            log.debug("****** NEXT CALLED. FINISHED IS " + finished + ", pos is " + pos.inspect());
            var newPos = null;
            if (!finished) {
                if (!backward) {
                    newPos = pos.nextVisible();
                }
                finished = !newPos || (endPos && newPos.equals(endPos));
                if (backward) {
                    newPos = pos.previousVisible();
                }
            }
            log.info("Finished: " + finished);
            pos = newPos;
            return pos;
        }

        var previousTextPos, returnPreviousTextPos = false;

        return {
            next: function() {
                if (returnPreviousTextPos) {
                    returnPreviousTextPos = false;
                    return previousTextPos;
                } else {
                    var pos, character;
                    while ( (pos = next()) ) {
                        character = pos.getCharacter(characterOptions);
                        if (character) {
                            previousTextPos = pos;
                            return pos;
                        }
                    }
                    return null;
                }
            },

            rewind: function() {
                if (previousTextPos) {
                    returnPreviousTextPos = true;
                } else {
                    throw module.createError("createCharacterIterator: cannot rewind. Only one position can be rewound.");
                }
            },

            dispose: function() {
                startPos = endPos = null;
            }
        };
    }

    var arrayIndexOf = Array.prototype.indexOf ?
        function(arr, val) {
            return arr.indexOf(val);
        } :
        function(arr, val) {
            for (var i = 0, len = arr.length; i < len; ++i) {
                if (arr[i] === val) {
                    return i;
                }
            }
            return -1;
        };

    // Provides a pair of iterators over text positions, tokenized. Transparently requests more text when next()
    // is called and there is no more tokenized text
    function createTokenizedTextProvider(pos, characterOptions, wordOptions) {
        var forwardIterator = createCharacterIterator(pos, false, null, characterOptions);
        var backwardIterator = createCharacterIterator(pos, true, null, characterOptions);
        var tokenizer = wordOptions.tokenizer;

        // Consumes a word and the whitespace beyond it
        function consumeWord(forward) {
            log.debug("consumeWord called, forward is " + forward);
            var pos, textChar;
            var newChars = [], it = forward ? forwardIterator : backwardIterator;

            var passedWordBoundary = false, insideWord = false;

            while ( (pos = it.next()) ) {
                textChar = pos.character;

                if (allWhiteSpaceRegex.test(textChar)) {
                    if (insideWord) {
                        insideWord = false;
                        passedWordBoundary = true;
                    }
                } else {
                    if (passedWordBoundary) {
                        it.rewind();
                        break;
                    } else {
                        insideWord = true;
                    }
                }
                newChars.push(pos);
            }

            log.debug("consumeWord got new chars " + newChars.join(""));
            return newChars;
        }

        // Get initial word surrounding initial position and tokenize it
        var forwardChars = consumeWord(true);
        var backwardChars = consumeWord(false).reverse();
        var tokens = tokenizer(backwardChars.concat(forwardChars), wordOptions);

        // Create initial token buffers
        var forwardTokensBuffer = forwardChars.length ?
            tokens.slice(arrayIndexOf(tokens, forwardChars[0].token)) : [];

        var backwardTokensBuffer = backwardChars.length ?
            tokens.slice(0, arrayIndexOf(tokens, backwardChars.pop().token) + 1) : [];

        function inspectBuffer(buffer) {
            var textPositions = ["[" + buffer.length + "]"];
            for (var i = 0; i < buffer.length; ++i) {
                textPositions.push("(word: " + buffer[i] + ", is word: " + buffer[i].isWord + ")");
            }
            return textPositions;
        }

        log.info("Initial word: ", inspectBuffer(forwardTokensBuffer) + "", " and ", inspectBuffer(backwardTokensBuffer) + "", forwardChars, backwardChars);

        return {
            nextEndToken: function() {
                var lastToken, forwardChars;

                // If we're down to the last token, consume character chunks until we have a word or run out of
                // characters to consume
                while ( forwardTokensBuffer.length == 1 &&
                    !(lastToken = forwardTokensBuffer[0]).isWord &&
                    (forwardChars = consumeWord(true)).length > 0) {

                    // Merge trailing non-word into next word and tokenize
                    forwardTokensBuffer = tokenizer(lastToken.chars.concat(forwardChars), wordOptions);
                }

                return forwardTokensBuffer.shift();
            },

            previousStartToken: function() {
                var lastToken, backwardChars;

                // If we're down to the last token, consume character chunks until we have a word or run out of
                // characters to consume
                while ( backwardTokensBuffer.length == 1 &&
                    !(lastToken = backwardTokensBuffer[0]).isWord &&
                    (backwardChars = consumeWord(false)).length > 0) {

                    // Merge leading non-word into next word and tokenize
                    backwardTokensBuffer = tokenizer(backwardChars.reverse().concat(lastToken.chars), options);
                }

                return backwardTokensBuffer.pop();
            },

            dispose: function() {
                forwardIterator.dispose();
                backwardIterator.dispose();
                forwardTokensBuffer = backwardTokensBuffer = null;
            }
        };
    }

    function movePositionBy(pos, unit, count, characterOptions, wordOptions) {
        log.info("movePositionBy called " + count);
        var unitsMoved = 0, newPos = pos, charIterator, nextPos, newTextPos, absCount = Math.abs(count), token;
        if (count !== 0) {
            var backward = (count < 0);

            switch (unit) {
                case CHARACTER:
                    charIterator = createCharacterIterator(pos, backward, null, characterOptions);
                    while ( (newPos = charIterator.next()) && unitsMoved < absCount ) {
                        log.info("*** movePositionBy GOT CHAR " + newPos.character + "[" + newPos.character.charCodeAt(0) + "]");
                        ++unitsMoved;
                    }
                    nextPos = newPos;
                    charIterator.dispose();
                    break;
                case WORD:
                    var tokenizedTextProvider = createTokenizedTextProvider(pos, characterOptions, wordOptions);
                    var next = backward ? tokenizedTextProvider.previousStartToken : tokenizedTextProvider.nextEndToken;

                    while ( (token = next()) && unitsMoved < absCount ) {
                        log.debug("token: " + token.chars.join(""), token.isWord);
                        if (token.isWord) {
                            ++unitsMoved;
                            log.info("**** FOUND END OF WORD. unitsMoved NOW " + unitsMoved);
                            newPos = backward ? token.chars[0] : token.chars[token.chars.length - 1];
                        }
                    }
                    break;
                default:
                    throw new Error("movePositionBy: unit '" + unit + "' not implemented");
            }

            // Perform any necessary position tweaks
            if (backward) {
                log.debug("Adjusting position. Current newPos: " + newPos);
                newPos = newPos.previousVisible();
                log.debug("newPos now: " + newPos);
                unitsMoved = -unitsMoved;
            } else if (newTextPos && newTextPos.isLeadingSpace) {
                // Tweak the position for the case of a leading space. The problem is that an uncollapsed leading space
                // before a block element (for example, the line break between "1" and "2" in the following HTML:
                // "1<p>2</p>") is considered to be attached to the position immediately before the block element, which
                // corresponds with a different selection position in most browsers from the one we want (i.e. at the
                // start of the contents of the block element). We get round this by advancing the position returned to
                // the last possible equivalent visible position.
                log.info("movePositionBy ended immediately after a leading space at " + newPos);
                if (unit == WORD) {
                    charIterator = createCharacterIterator(pos, false, null, characterOptions);
                    nextPos = charIterator.next();
                    charIterator.dispose();
                }
                if (nextPos) {
                    newPos = nextPos.previousVisible();
                    log.info("movePositionBy adjusted leading space position to " + newPos);
                }
            }
        }

        return {
            position: newPos,
            unitsMoved: unitsMoved
        };
    }

    function createRangeCharacterIterator(transaction, range, characterOptions, backward) {
        var rangeStart = transaction.getRangeBoundaryPosition(range, true);
        var rangeEnd = transaction.getRangeBoundaryPosition(range, false);
        var itStart = backward ? rangeEnd : rangeStart;
        var itEnd = backward ? rangeStart : rangeEnd;

        return createCharacterIterator(itStart, !!backward, itEnd, characterOptions);
    }

    function getRangeCharacters(transaction, range, characterOptions) {
        log.info("getRangeCharacters called on range " + range.inspect());

        var chars = [], it = createRangeCharacterIterator(transaction, range, characterOptions), pos;
        while ( (pos = it.next()) ) {
            log.info("*** GOT CHAR " + pos.character + "[" + pos.character.charCodeAt(0) + "] for " + pos.inspect());
            chars.push(pos);
        }

        it.dispose();
        return chars;
    }

    function isWholeWord(startPos, endPos, wordOptions) {
        var range = api.createRange(startPos.node);
        range.setStart(startPos.node, startPos.offset);
        range.setEnd(endPos.node, endPos.offset);
        var returnVal = !range.expand("word", wordOptions);
        range.detach();
        return returnVal;
    }

    function findTextFromPosition(initialPos, searchTerm, isRegex, searchScopeRange, findOptions) {
        log.debug("findTextFromPosition called with search term " + searchTerm + ", initialPos " + initialPos.inspect() + " within range " + searchScopeRange.inspect());
        var backward = isDirectionBackward(findOptions.direction);
        var it = createCharacterIterator(
            initialPos,
            backward,
            initialPos.transaction.getRangeBoundaryPosition(searchScopeRange, backward),
            findOptions
        );
        var text = "", chars = [], pos, currentChar, matchStartIndex, matchEndIndex;
        var result, insideRegexMatch;
        var returnValue = null;

        function handleMatch(startIndex, endIndex) {
            var startPos = chars[startIndex].previousVisible();
            var endPos = chars[endIndex - 1];
            var valid = (!findOptions.wholeWordsOnly || isWholeWord(startPos, endPos, findOptions.wordOptions));

            return {
                startPos: startPos,
                endPos: endPos,
                valid: valid
            };
        }

        while ( (pos = it.next()) ) {
            currentChar = pos.character;
            if (!isRegex && !findOptions.caseSensitive) {
                currentChar = currentChar.toLowerCase();
            }

            if (backward) {
                chars.unshift(pos);
                text = currentChar + text;
            } else {
                chars.push(pos);
                text += currentChar;
            }

            if (isRegex) {
                result = searchTerm.exec(text);
                if (result) {
                    if (insideRegexMatch) {
                        // Check whether the match is now over
                        matchStartIndex = result.index;
                        matchEndIndex = matchStartIndex + result[0].length;
                        if ((!backward && matchEndIndex < text.length) || (backward && matchStartIndex > 0)) {
                            returnValue = handleMatch(matchStartIndex, matchEndIndex);
                            break;
                        }
                    } else {
                        insideRegexMatch = true;
                    }
                }
            } else if ( (matchStartIndex = text.indexOf(searchTerm)) != -1 ) {
                returnValue = handleMatch(matchStartIndex, matchStartIndex + searchTerm.length);
                break;
            }
        }

        // Check whether regex match extends to the end of the range
        if (insideRegexMatch) {
            returnValue = handleMatch(matchStartIndex, matchEndIndex);
        }
        it.dispose();

        return returnValue;
    }

    function createEntryPointFunction(func) {
        return function() {
            var transactionRunning = !!currentTransaction;
            var transaction = getTransaction();
            var args = [transaction].concat( Array.prototype.slice.call(arguments, 0) );
            var returnValue = func.apply(this, args);
            if (!transactionRunning) {
                endTransaction();
            }
            return returnValue;
        }
    }

    /*----------------------------------------------------------------------------------------------------------------*/

    // Extensions to the Rangy Range object

    function createRangeBoundaryMover(isStart, collapse) {
        /*
         Unit can be "character" or "word"
         Options:

         - includeTrailingSpace
         - wordRegex
         - tokenizer
         - collapseSpaceBeforeLineBreak
         */
        return createEntryPointFunction(
            function(transaction, unit, count, moveOptions) {
                if (typeof count == "undefined") {
                    count = unit;
                    unit = CHARACTER;
                }
                moveOptions = createOptions(moveOptions, defaultMoveOptions);
                var characterOptions = createOptions(moveOptions.characterOptions, defaultCharacterOptions);
                var wordOptions = createWordOptions(moveOptions.wordOptions);
                log.debug("** moving boundary. start: " + isStart + ", unit: " + unit + ", count: " + count);

                var boundaryIsStart = isStart;
                if (collapse) {
                    boundaryIsStart = (count >= 0);
                    this.collapse(!boundaryIsStart);
                }
                var moveResult = movePositionBy(transaction.getRangeBoundaryPosition(this, boundaryIsStart), unit, count, characterOptions, wordOptions);
                var newPos = moveResult.position;
                this[boundaryIsStart ? "setStart" : "setEnd"](newPos.node, newPos.offset);
                return moveResult.unitsMoved;
            }
        );
    }

    function createRangeTrimmer(isStart) {
        return createEntryPointFunction(
            function(transaction, characterOptions) {
                characterOptions = createOptions(characterOptions, defaultCharacterOptions);
                var pos;
                var it = createRangeCharacterIterator(transaction, this, characterOptions, !isStart);
                var trimCharCount = 0;
                while ( (pos = it.next()) && allWhiteSpaceRegex.test(pos.character) ) {
                    ++trimCharCount;
                }
                it.dispose();
                var trimmed = (trimCharCount > 0);
                if (trimmed) {
                    this[isStart ? "moveStart" : "moveEnd"](
                        "character",
                        isStart ? trimCharCount : -trimCharCount,
                        { characterOptions: characterOptions }
                    );
                }
                return trimmed;
            }
        );
    }

    extend(api.rangePrototype, {
        moveStart: createRangeBoundaryMover(true, false),

        moveEnd: createRangeBoundaryMover(false, false),

        move: createRangeBoundaryMover(true, true),

        trimStart: createRangeTrimmer(true),

        trimEnd: createRangeTrimmer(false),

        trim: createEntryPointFunction(
            function(transaction, characterOptions) {
                var startTrimmed = this.trimStart(characterOptions), endTrimmed = this.trimEnd(characterOptions);
                return startTrimmed || endTrimmed;
            }
        ),

        expand: function(unit, expandOptions) {
            var moved = false;
            expandOptions = createOptions(expandOptions, defaultExpandOptions);
            var characterOptions = createOptions(expandOptions.characterOptions, defaultCharacterOptions);
            if (!unit) {
                unit = CHARACTER;
            }
            if (unit == WORD) {
                var wordOptions = createWordOptions(expandOptions.wordOptions);
                var startPos = getRangeStartPosition(this);
                var endPos = getRangeEndPosition(this);

                var startTokenizedTextProvider = createTokenizedTextProvider(startPos, characterOptions, wordOptions);
                var startToken = startTokenizedTextProvider.nextEndToken();
                var newStartPos = previousVisiblePosition(startToken.chars[0].position);
                var endToken, newEndPos;

                if (this.collapsed) {
                    endToken = startToken;
                } else {
                    var endTokenizedTextProvider = createTokenizedTextProvider(endPos, characterOptions, wordOptions);
                    endToken = endTokenizedTextProvider.previousStartToken();
                }
                newEndPos = endToken.chars[endToken.chars.length - 1].position;

                if (!newStartPos.equals(startPos)) {
                    this.setStart(newStartPos.node, newStartPos.offset);
                    moved = true;
                }
                if (!newEndPos.equals(endPos)) {
                    this.setEnd(newEndPos.node, newEndPos.offset);
                    moved = true;
                }

                if (expandOptions.trim) {
                    if (expandOptions.trimStart) {
                        moved = this.trimStart(characterOptions) || moved;
                    }
                    if (expandOptions.trimEnd) {
                        moved = this.trimEnd(characterOptions) || moved;
                    }
                }

                return moved;
            } else {
                return this.moveEnd(CHARACTER, 1, expandOptions);
            }
        },

        text: createEntryPointFunction(
            function(transaction, characterOptions) {
                log.info("text. Transaction: " + transaction + ", characterOptions:", characterOptions);
                return this.collapsed ?
                    "" : getRangeCharacters(transaction, this, createOptions(characterOptions, defaultCharacterOptions)).join("");
            }
        ),

        selectCharacters: function(containerNode, startIndex, endIndex, characterOptions) {
            var moveOptions = { characterOptions: characterOptions };
            this.selectNodeContents(containerNode);
            this.collapse(true);
            this.moveStart("character", startIndex, moveOptions);
            this.collapse(true);
            this.moveEnd("character", endIndex - startIndex, moveOptions);
        },

        // Character indexes are relative to the start of node
        toCharacterRange: function(containerNode, characterOptions) {
            if (!containerNode) {
                containerNode = document.body;
            }
            var parent = containerNode.parentNode, nodeIndex = dom.getNodeIndex(containerNode);
            var rangeStartsBeforeNode = (dom.comparePoints(this.startContainer, this.endContainer, parent, nodeIndex) == -1);
            var rangeBetween = this.cloneRange();
            var startIndex, endIndex;
            if (rangeStartsBeforeNode) {
                rangeBetween.setStart(this.startContainer, this.startOffset);
                rangeBetween.setEnd(parent, nodeIndex);
                startIndex = -rangeBetween.text(characterOptions).length;
            } else {
                rangeBetween.setStart(parent, nodeIndex);
                rangeBetween.setEnd(this.startContainer, this.startOffset);
                startIndex = rangeBetween.text(characterOptions).length;
            }
            endIndex = startIndex + this.text(characterOptions).length;

            return {
                start: startIndex,
                end: endIndex
            };
        },

        findText: function(searchTermParam, findOptions) {
            // Set up options
            findOptions = createOptions(findOptions, defaultFindOptions);

            // Create word options if we're matching whole words only
            if (findOptions.wholeWordsOnly) {
                findOptions.wordOptions = createWordOptions(findOptions.wordOptions);

                // We don't ever want trailing spaces for search results
                findOptions.wordOptions.includeTrailingSpace = false;
            }

            var backward = isDirectionBackward(findOptions.direction);

            // Create a range representing the search scope if none was provided
            var searchScopeRange = findOptions.withinRange;
            if (!searchScopeRange) {
                searchScopeRange = api.createRange();
                searchScopeRange.selectNodeContents(this.getDocument());
            }

            // Examine and prepare the search term
            var searchTerm = searchTermParam, isRegex = false;
            if (typeof searchTerm == "string") {
                if (!findOptions.caseSensitive) {
                    searchTerm = searchTerm.toLowerCase();
                }
            } else {
                isRegex = true;
            }

            var initialPos = backward ? getRangeEndPosition(this) : getRangeStartPosition(this);

            // Adjust initial position if it lies outside the search scope
            var comparison = searchScopeRange.comparePoint(initialPos.node, initialPos.offset);
            if (comparison === -1) {
                initialPos = getRangeStartPosition(searchScopeRange);
            } else if (comparison === 1) {
                initialPos = getRangeEndPosition(searchScopeRange);
            }

            var pos = initialPos;
            var wrappedAround = false;

            // Try to find a match and ignore invalid ones
            var findResult;
            while (true) {
                findResult = findTextFromPosition(pos, searchTerm, isRegex, searchScopeRange, findOptions);

                if (findResult) {
                    if (findResult.valid) {
                        this.setStart(findResult.startPos.node, findResult.startPos.offset);
                        this.setEnd(findResult.endPos.node, findResult.endPos.offset);
                        return true;
                    } else {
                        // We've found a match that is not a whole word, so we carry on searching from the point immediately
                        // after the match
                        pos = backward ? findResult.startPos : findResult.endPos;
                    }
                } else if (findOptions.wrap && !wrappedAround) {
                    // No result found but we're wrapping around and limiting the scope to the unsearched part of the range
                    searchScopeRange = searchScopeRange.cloneRange();
                    if (backward) {
                        pos = getRangeEndPosition(searchScopeRange);
                        searchScopeRange.setStart(initialPos.node, initialPos.offset);
                    } else {
                        pos = getRangeStartPosition(searchScopeRange);
                        searchScopeRange.setEnd(initialPos.node, initialPos.offset);
                    }
                    log.debug("Wrapping search. New search range is " + searchScopeRange.inspect());
                    wrappedAround = true;
                } else {
                    // Nothing found and we can't wrap around, so we're done
                    return false;
                }
            }
        },

        pasteHtml: function(html) {
            this.deleteContents();
            if (html) {
                var frag = this.createContextualFragment(html);
                var lastChild = frag.lastChild;
                this.insertNode(frag);
                this.collapseAfter(lastChild);
            }
        }
    });

    /*----------------------------------------------------------------------------------------------------------------*/

    // Extensions to the Rangy Selection object

    function createSelectionTrimmer(methodName) {
        return function(characterOptions) {
            var trimmed = false;
            this.changeEachRange(function(range) {
                trimmed = range[methodName](characterOptions) || trimmed;
            });
            return trimmed;
        }
    }

    extend(api.selectionPrototype, {
        expand: function(unit, expandOptions) {
            this.changeEachRange(function(range) {
                range.expand(unit, expandOptions);
            });
        },

        move: function(unit, count, options) {
            if (this.focusNode) {
                this.collapse(this.focusNode, this.focusOffset);
                var range = this.getRangeAt(0);
                range.move(unit, count, options);
                this.setSingleRange(range);
            }
        },

        trimStart: createSelectionTrimmer("trimStart"),
        trimEnd: createSelectionTrimmer("trimEnd"),
        trim: createSelectionTrimmer("trim"),

        selectCharacters: function(containerNode, startIndex, endIndex, direction, characterOptions) {
            var range = api.createRange(containerNode);
            range.selectCharacters(containerNode, startIndex, endIndex, characterOptions);
            this.setSingleRange(range, direction);
        },

        saveCharacterRanges: function(containerNode, characterOptions) {
            var ranges = this.getAllRanges(), rangeCount = ranges.length;
            var characterRanges = [];

            var backward = rangeCount == 1 && this.isBackward();

            for (var i = 0, len = ranges.length; i < len; ++i) {
                characterRanges[i] = {
                    range: ranges[i].toCharacterRange(containerNode, characterOptions),
                    backward: backward,
                    characterOptions: characterOptions
                };
            }

            return characterRanges;
        },

        restoreCharacterRanges: function(containerNode, characterRanges) {
            this.removeAllRanges();
            for (var i = 0, len = characterRanges.length, range, characterRange; i < len; ++i) {
                characterRange = characterRanges[i];
                range = api.createRange(containerNode);
                range.selectCharacters(containerNode, characterRange.range.start, characterRange.range.end, characterRange.characterOptions);
                this.addRange(range, characterRange.backward);
            }
        },

        text: function(characterOptions) {
            var rangeTexts = [];
            for (var i = 0, len = this.rangeCount; i < len; ++i) {
                rangeTexts[i] = this.getRangeAt(i).text(characterOptions);
            }
            return rangeTexts.join("");
        }
    });

    /*----------------------------------------------------------------------------------------------------------------*/

    // Extensions to the core rangy object

    api.innerText = function(el, characterOptions) {
        var range = api.createRange(el);
        range.selectNodeContents(el);
        var text = range.text(characterOptions);
        range.detach();
        log.debug("innerText is '" + text.replace(/\s/g, function(matched) { return "[" + matched.charCodeAt(0) + "]"; }) + "'");
        return text;
    };

    api.createWordIterator = function(startNode, startOffset, iteratorOptions) {
        iteratorOptions = createOptions(iteratorOptions, defaultWordIteratorOptions);
        characterOptions = createOptions(iteratorOptions.characterOptions, defaultCharacterOptions);
        wordOptions = createWordOptions(iteratorOptions.wordOptions);
        var startPos = new DomPosition(startNode, startOffset);
        var tokenizedTextProvider = createTokenizedTextProvider(startPos, characterOptions, wordOptions);
        var backward = isDirectionBackward(iteratorOptions.direction);

        return {
            next: function() {
                return backward ? tokenizedTextProvider.previousStartToken() : tokenizedTextProvider.nextEndToken();
            },

            dispose: function() {
                tokenizedTextProvider.dispose();
                this.next = function() {};
            }
        };
    };

    /*----------------------------------------------------------------------------------------------------------------*/

    api.textRange = {
        isBlockNode: isBlockNode,
        isCollapsedWhitespaceNode: isCollapsedWhitespaceNode,
        startTransaction: startTransaction,
        endTransaction: endTransaction,
        createPosition: function(node, offset) {
            return startTransaction().getPosition(node, offset);
        }
    };
});