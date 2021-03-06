/**
 * WARNING: New methods on groupTypes should be added to src/functions.
 *
 * This file does the main work of building a domTree structure from a parse
 * tree. The entry point is the `buildHTML` function, which takes a parse tree.
 * Then, the buildExpression, buildGroup, and various groupTypes functions are
 * called, to produce a final HTML tree.
 */

import ParseError from "./ParseError";
import Style from "./Style";

import buildCommon from "./buildCommon";
import domTree from "./domTree";
import utils from "./utils";
import {spacings, tightSpacings} from "./spacingData";

const makeSpan = buildCommon.makeSpan;

// Binary atoms (first class `mbin`) change into ordinary atoms (`mord`)
// depending on their surroundings. See TeXbook pg. 442-446, Rules 5 and 6,
// and the text before Rule 19.
const isBinLeftCanceller = function(node, isRealGroup) {
    // TODO: This code assumes that a node's math class is the first element
    // of its `classes` array. A later cleanup should ensure this, for
    // instance by changing the signature of `makeSpan`.
    if (node) {
        return utils.contains(["mbin", "mopen", "mrel", "mop", "mpunct"],
                              getTypeOfDomTree(node, "right"));
    } else {
        return isRealGroup;
    }
};

const isBinRightCanceller = function(node, isRealGroup) {
    if (node) {
        return utils.contains(["mrel", "mclose", "mpunct"],
                              getTypeOfDomTree(node, "left"));
    } else {
        return isRealGroup;
    }
};

const styleMap = {
    "display": Style.DISPLAY,
    "text": Style.TEXT,
    "script": Style.SCRIPT,
    "scriptscript": Style.SCRIPTSCRIPT,
};

/**
 * Take a list of nodes, build them in order, and return a list of the built
 * nodes. documentFragments are flattened into their contents, so the
 * returned list contains no fragments. `isRealGroup` is true if `expression`
 * is a real group (no atoms will be added on either side), as opposed to
 * a partial group (e.g. one created by \color). `surrounding` is an array
 * consisting type of nodes that will be added to the left and right.
 */
export const buildExpression = function(expression, options, isRealGroup,
        surrounding = [null, null]) {
    // Parse expressions into `groups`.
    const rawGroups = [];
    for (let i = 0; i < expression.length; i++) {
        const output = buildGroup(expression[i], options);
        if (output instanceof domTree.documentFragment) {
            rawGroups.push(...output.children);
        } else {
            rawGroups.push(output);
        }
    }
    // At this point `rawGroups` consists entirely of `symbolNode`s and `span`s.

    // Ignore explicit spaces (e.g., \;, \,) when determining what implicit
    // spacing should go between atoms of different classes, and add dummy
    // spans for determining spacings between surrounding atoms
    const nonSpaces = [
        surrounding[0] && makeSpan([surrounding[0]], [], options),
        ...rawGroups.filter(group => group && group.classes[0] !== "mspace"),
        surrounding[1] && makeSpan([surrounding[1]], [], options),
    ];

    // Before determining what spaces to insert, perform bin cancellation.
    // Binary operators change to ordinary symbols in some contexts.
    for (let i = 1; i < nonSpaces.length - 1; i++) {
        const left = getOutermostNode(nonSpaces[i], "left");
        if (left.classes[0] === "mbin" &&
                isBinLeftCanceller(nonSpaces[i - 1], isRealGroup)) {
            left.classes[0] = "mord";
        }

        const right = getOutermostNode(nonSpaces[i], "right");
        if (right.classes[0] === "mbin" &&
                isBinRightCanceller(nonSpaces[i + 1], isRealGroup)) {
            right.classes[0] = "mord";
        }
    }

    const groups = [];
    let j = 0;
    for (let i = 0; i < rawGroups.length; i++) {
        groups.push(rawGroups[i]);

        // For any group that is not a space, get the next non-space.  Then
        // lookup what implicit space should be placed between those atoms and
        // add it to groups.
        if (rawGroups[i].classes[0] !== "mspace" && j < nonSpaces.length - 1) {
            // if current non-space node is left dummy span, add a glue before
            // first real non-space node
            if (j === 0) {
                groups.pop();
                i--;
            }

            // Get the type of the current non-space node.  If it's a document
            // fragment, get the type of the rightmost node in the fragment.
            const left = getTypeOfDomTree(nonSpaces[j], "right");

            // Get the type of the next non-space node.  If it's a document
            // fragment, get the type of the leftmost node in the fragment.
            const right = getTypeOfDomTree(nonSpaces[j + 1], "left");

            // We use buildExpression inside of sizingGroup, but it returns a
            // document fragment of elements.  sizingGroup sets `isRealGroup`
            // to false to avoid processing spans multiple times.
            if (left && right && isRealGroup) {
                const space = isLeftTight(nonSpaces[j + 1])
                    ? tightSpacings[left][right]
                    : spacings[left][right];

                if (space) {
                    let glueOptions = options;

                    if (expression.length === 1) {
                        if (expression[0].type === "sizing") {
                            glueOptions = options.havingSize(
                                expression[0].value.size);
                        } else if (expression[0].type === "styling") {
                            glueOptions = options.havingStyle(
                                styleMap[expression[0].value.style]);
                        }
                    }

                    groups.push(buildCommon.makeGlue(space, glueOptions));
                }
            }
            j++;
        }
    }

    // Process \\not commands within the group.
    for (let i = 0; i < groups.length; i++) {
        if (groups[i].value === "\u0338") {
            groups[i].style.position = "absolute";
            // TODO(kevinb) fix this for Safari by switching to a non-combining
            // character for \not.
            // This value was determined empirically.
            // TODO(kevinb) figure out the real math for this value.
            groups[i].style.paddingLeft = "0.8em";
        }
    }

    return groups;
};

// Return the outermost node of a domTree.
const getOutermostNode = function(node, side = "right") {
    if (node instanceof domTree.documentFragment ||
            node instanceof domTree.anchor) {
        if (node.children.length) {
            if (side === "right") {
                return getOutermostNode(
                    node.children[node.children.length - 1]);
            } else if (side === "left") {
                return getOutermostNode(
                    node.children[0]);
            }
        }
    }
    return node;
};

// Return math atom class (mclass) of a domTree.
export const getTypeOfDomTree = function(node, side = "right") {
    if (!node) {
        return null;
    }

    node = getOutermostNode(node, side);
    // This makes a lot of assumptions as to where the type of atom
    // appears.  We should do a better job of enforcing this.
    if (utils.contains([
        "mord", "mop", "mbin", "mrel", "mopen", "mclose",
        "mpunct", "minner",
    ], node.classes[0])) {
        return node.classes[0];
    }
    return null;
};

// If `node` is an atom return whether it's been assigned the mtight class.
// If `node` is a document fragment, return the value of isLeftTight() for the
// leftmost node in the fragment.
// 'mtight' indicates that the node is script or scriptscript style.
export const isLeftTight = function(node) {
    node = getOutermostNode(node, "left");
    return node.hasClass("mtight");
};

/**
 * Sometimes, groups perform special rules when they have superscripts or
 * subscripts attached to them. This function lets the `supsub` group know that
 * its inner element should handle the superscripts and subscripts instead of
 * handling them itself.
 */
const shouldHandleSupSub = function(group, options) {
    const base = group.value.base;
    if (!base) {
        return false;
    } else if (base.type === "op") {
        // Operators handle supsubs differently when they have limits
        // (e.g. `\displaystyle\sum_2^3`)
        return base.value.limits &&
            (options.style.size === Style.DISPLAY.size ||
            base.value.alwaysHandleSupSub);
    } else if (base.type === "accent") {
        return utils.isCharacterBox(base.value.base);
    } else if (base.type === "horizBrace") {
        const isSup = !group.value.sub;
        return (isSup === base.value.isOver);
    } else {
        return false;
    }
};

export const makeNullDelimiter = function(options, classes) {
    const moreClasses = ["nulldelimiter"].concat(options.baseSizingClasses());
    return makeSpan(classes.concat(moreClasses));
};

/**
 * This is a map of group types to the function used to handle that type.
 * Simpler types come at the beginning, while complicated types come afterwards.
 */
export const groupTypes = {
    ordgroup: (group, options) => makeSpan(
        ["mord"], buildExpression(group.value, options, true), options),

    supsub(group, options) {
        // Superscript and subscripts are handled in the TeXbook on page
        // 445-446, rules 18(a-f).

        // Here is where we defer to the inner group if it should handle
        // superscripts and subscripts itself.
        if (shouldHandleSupSub(group, options)) {
            return groupTypes[group.value.base.type](group, options);
        }

        const base = buildGroup(group.value.base, options);
        let supm;
        let subm;

        const metrics = options.fontMetrics();
        let newOptions;

        // Rule 18a
        let supShift = 0;
        let subShift = 0;

        if (group.value.sup) {
            newOptions = options.havingStyle(options.style.sup());
            supm = buildGroup(group.value.sup, newOptions, options);
            if (!utils.isCharacterBox(group.value.base)) {
                supShift = base.height - newOptions.fontMetrics().supDrop
                    * newOptions.sizeMultiplier / options.sizeMultiplier;
            }
        }

        if (group.value.sub) {
            newOptions = options.havingStyle(options.style.sub());
            subm = buildGroup(group.value.sub, newOptions, options);
            if (!utils.isCharacterBox(group.value.base)) {
                subShift = base.depth + newOptions.fontMetrics().subDrop
                    * newOptions.sizeMultiplier / options.sizeMultiplier;
            }
        }

        // Rule 18c
        let minSupShift;
        if (options.style === Style.DISPLAY) {
            minSupShift = metrics.sup1;
        } else if (options.style.cramped) {
            minSupShift = metrics.sup3;
        } else {
            minSupShift = metrics.sup2;
        }

        // scriptspace is a font-size-independent size, so scale it
        // appropriately for use as the marginRight.
        const multiplier = options.sizeMultiplier;
        const marginRight = (0.5 / metrics.ptPerEm) / multiplier + "em";

        let supsub;
        if (!group.value.sup) {
            // Rule 18b
            subShift = Math.max(
                subShift, metrics.sub1,
                subm.height - 0.8 * metrics.xHeight);

            const vlistElem = [{type: "elem", elem: subm, marginRight}];
            // Subscripts shouldn't be shifted by the base's italic correction.
            // Account for that by shifting the subscript back the appropriate
            // amount. Note we only do this when the base is a single symbol.
            if (base instanceof domTree.symbolNode) {
                vlistElem[0].marginLeft = -base.italic + "em";
            }

            supsub = buildCommon.makeVList({
                positionType: "shift",
                positionData: subShift,
                children: vlistElem,
            }, options);
        } else if (!group.value.sub) {
            // Rule 18c, d
            supShift = Math.max(supShift, minSupShift,
                supm.depth + 0.25 * metrics.xHeight);

            supsub = buildCommon.makeVList({
                positionType: "shift",
                positionData: -supShift,
                children: [{type: "elem", elem: supm, marginRight}],
            }, options);
        } else {
            supShift = Math.max(
                supShift, minSupShift, supm.depth + 0.25 * metrics.xHeight);
            subShift = Math.max(subShift, metrics.sub2);

            const ruleWidth = metrics.defaultRuleThickness;

            // Rule 18e
            const maxWidth = 4 * ruleWidth;
            if ((supShift - supm.depth) - (subm.height - subShift) < maxWidth) {
                subShift = maxWidth - (supShift - supm.depth) + subm.height;
                const psi = 0.8 * metrics.xHeight - (supShift - supm.depth);
                if (psi > 0) {
                    supShift += psi;
                    subShift -= psi;
                }
            }

            const vlistElem = [
                {type: "elem", elem: subm, shift: subShift, marginRight},
                {type: "elem", elem: supm, shift: -supShift, marginRight},
            ];
            // See comment above about subscripts not being shifted.
            if (base instanceof domTree.symbolNode) {
                vlistElem[0].marginLeft = -base.italic + "em";
            }

            supsub = buildCommon.makeVList({
                positionType: "individualShift",
                children: vlistElem,
            }, options);
        }

        // Wrap the supsub vlist in a span.msupsub to reset text-align.
        const mclass = getTypeOfDomTree(base) || "mord";
        return makeSpan([mclass],
            [base, makeSpan(["msupsub"], [supsub])],
            options);
    },

    spacing(group, options) {
        if (buildCommon.regularSpace.hasOwnProperty(group.value)) {
            const className = buildCommon.regularSpace[group.value].className;
            // Spaces are generated by adding an actual space. Each of these
            // things has an entry in the symbols table, so these will be turned
            // into appropriate outputs.
            if (group.mode === "text") {
                const ord = buildCommon.makeOrd(group, options, "textord");
                ord.classes.push(className);
                return ord;
            } else {
                return makeSpan(["mspace", className],
                    [buildCommon.mathsym(group.value, group.mode, options)],
                    options);
            }
        } else {
            // Other kinds of spaces are of arbitrary width. We use CSS to
            // generate these.
            return makeSpan(
                ["mspace", buildCommon.spacingFunctions[group.value].className],
                [], options);
        }
    },
};

/**
 * buildGroup is the function that takes a group and calls the correct groupType
 * function for it. It also handles the interaction of size and style changes
 * between parents and children.
 */
export const buildGroup = function(group, options, baseOptions) {
    if (!group) {
        return makeSpan();
    }

    if (groupTypes[group.type]) {
        // Call the groupTypes function
        let groupNode = groupTypes[group.type](group, options);

        // If the size changed between the parent and the current group, account
        // for that size difference.
        if (baseOptions && options.size !== baseOptions.size) {
            groupNode = makeSpan(options.sizingClasses(baseOptions),
                [groupNode], options);

            const multiplier =
                options.sizeMultiplier / baseOptions.sizeMultiplier;

            groupNode.height *= multiplier;
            groupNode.depth *= multiplier;
        }

        return groupNode;
    } else {
        throw new ParseError(
            "Got group of unknown type: '" + group.type + "'");
    }
};

/**
 * Combine an array of HTML DOM nodes (e.g., the output of `buildExpression`)
 * into an unbreakable HTML node of class .base, with proper struts to
 * guarantee correct vertical extent.  `buildHTML` calls this repeatedly to
 * make up the entire expression as a sequence of unbreakable units.
 */
function buildHTMLUnbreakable(children, options) {
    // Compute height and depth of this chunk.
    const body = makeSpan(["base"], children, options);

    // Add strut, which ensures that the top of the HTML element falls at
    // the height of the expression, and the bottom of the HTML element
    // falls at the depth of the expression.
    // We used to have separate top and bottom struts, where the bottom strut
    // would like to use `vertical-align: top`, but in IE 9 this lowers the
    // baseline of the box to the bottom of this strut (instead of staying in
    // the normal place) so we use an absolute value for vertical-align instead.
    const strut = makeSpan(["strut"]);
    strut.style.height = (body.height + body.depth) + "em";
    strut.style.verticalAlign = -body.depth + "em";
    body.children.unshift(strut);

    return body;
}

/**
 * Take an entire parse tree, and build it into an appropriate set of HTML
 * nodes.
 */
export default function buildHTML(tree, options) {
    // buildExpression is destructive, so we need to make a clone
    // of the incoming tree so that it isn't accidentally changed
    tree = JSON.parse(JSON.stringify(tree));

    // Strip off outer tag wrapper for processing below.
    let tag = null;
    if (tree.length === 1 && tree[0].type === "tag") {
        tag = tree[0].value.tag;
        tree = tree[0].value.body;
    }

    // Build the expression contained in the tree
    const expression = buildExpression(tree, options, true);

    const children = [];

    // Create one base node for each chunk between potential line breaks.
    // The TeXBook [p.173] says "A formula will be broken only after a
    // relation symbol like $=$ or $<$ or $\rightarrow$, or after a binary
    // operation symbol like $+$ or $-$ or $\times$, where the relation or
    // binary operation is on the ``outer level'' of the formula (i.e., not
    // enclosed in {...} and not part of an \over construction)."

    let parts = [];
    for (let i = 0; i < expression.length; i++) {
        parts.push(expression[i]);
        if (expression[i].hasClass("mbin") ||
            expression[i].hasClass("mrel") ||
            expression[i].hasClass("allowbreak")) {
            // Put any post-operator glue on same line as operator.
            // Watch for \nobreak along the way.
            let nobreak = false;
            while (i < expression.length - 1 &&
                   expression[i + 1].hasClass("mspace")) {
                i++;
                parts.push(expression[i]);
                if (expression[i].hasClass("nobreak")) {
                    nobreak = true;
                }
            }
            // Don't allow break if \nobreak among the post-operator glue.
            if (!nobreak) {
                children.push(buildHTMLUnbreakable(parts, options));
                parts = [];
            }
        } else if (expression[i].hasClass("newline")) {
            // Write the line except the newline
            parts.pop();
            if (parts.length > 0) {
                children.push(buildHTMLUnbreakable(parts, options));
                parts = [];
            }
            // Put the newline at the top level
            children.push(expression[i]);
        }
    }
    if (parts.length > 0) {
        children.push(buildHTMLUnbreakable(parts, options));
    }

    // Now, if there was a tag, build it too and append it as a final child.
    let tagChild;
    if (tag) {
        tagChild = buildHTMLUnbreakable(
            buildExpression(tag, options, true)
        );
        tagChild.classes = ["tag"];
        children.push(tagChild);
    }

    const htmlNode = makeSpan(["katex-html"], children);
    htmlNode.setAttribute("aria-hidden", "true");

    // Adjust the strut of the tag to be the maximum height of all children
    // (the height of the enclosing htmlNode) for proper vertical alignment.
    if (tag) {
        const strut = tagChild.children[0];
        strut.style.height = (htmlNode.height + htmlNode.depth) + "em";
        strut.style.verticalAlign = (-htmlNode.depth) + "em";
    }

    return htmlNode;
}
