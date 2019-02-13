"use strict";

class CmSentence {

    constructor(start, end, text, is_comment) {
        // start, end: {line: l, ch: c}
        this.start = start;
        this.end   = end;
        this.text  = text;
        this.mark  = undefined;
        this.is_comment = is_comment;
        this.feedback = [];
    }

}

// A CodeMirror-based Provider of coq statements.
class CmCoqProvider {

    constructor(element, options) {

        var cmOpts =
            { mode : { name : "coq",
                       version: 4,
                       singleLineStringErrors : false
                     },
              lineNumbers       : true,
              indentUnit        : 4,
              matchBrackets     : true,
              styleSelectedText : true,
              keyMap            : "emacs"
            };

        if (options)
            copyOptions(options, cmOpts);

        if (typeof element === 'string' || element instanceof String) {
            this.editor = CodeMirror.fromTextArea(document.getElementById(element), cmOpts);
        } else {
            this.editor = CodeMirror(element, cmOpts);
        }

        // Event handlers (to be overridden by ProviderContainer)
        this.onInvalidate = (mark) => {};
        this.onMouseEnter = (stm, ev) => {};
        this.onMouseLeave = (stm, ev) => {};
        this.onTipHover = (completion, zoom) => {};
        this.onTipOut = () => {};

        this.editor.on('beforeChange', (cm, evt) => this.onCMChange(cm, evt) );

        // Handle mouse hover events
        var editor_element = $(this.editor.getWrapperElement());
        editor_element.on('mousemove', ev => this.onCMMouseMove(ev));
        editor_element.on('mouseout', ev => this.onCMMouseLeave(ev));

        this._keyHandler = this.keyHandler.bind(this);
        this._key_bound = false;

        this.hover = [];

        // Handle hint events
        this.editor.on('hintHover',     completion => this.onTipHover(completion, false));
        this.editor.on('hintZoom',      completion => this.onTipHover(completion, true));
        this.editor.on('endCompletion', cm         => this.onTipOut());
    }

    focus() {
        this.editor.focus();
    }

    // If prev == null then get the first.
    getNext(prev, until) {

        var start = {line : 0, ch : 0};
        var doc = this.editor.getDoc();

        if (prev) {
            start = prev.end;
        }

        if (until && this.onlySpacesBetween(start, until))
            return null;

        // EOF
        if (start.line === doc.lastLine() &&
            start.ch === doc.getLine(doc.lastLine()).length) {
            return null;
        }

        var token = this.getNextToken(start, /statementend|bullet|brace/);
        if (!token) return null;

        var end = {line : token.line, ch : token.end};

        for (var mark of doc.findMarks(end,end)) {
            mark.clear();
        }

        var stm = new CmSentence(start, end,
                                 doc.getRange({line : start.line, ch : start.ch},
                                              {line : token.line, ch : token.end}),
                                 token.type === 'comment'  // XXX This is never true
                                );
        return stm;
    }

    // Gets sentence at point;
    getAtPoint() {

        var doc   = this.editor.getDoc();
        var marks = doc.findMarksAt(doc.getCursor());

        for (let mark of marks) {
            if (mark.stm) return mark.stm;
        }
    }

    // Mark a sentence with {clear, processing, error, ok}
    mark(stm, mark_type) {

        if (stm.mark) {
            let b = stm.mark.find();
            stm.start = b.from; stm.end = b.to;
            stm.mark.clear(); this._unmarkWidgets(stm.start, stm.end);
            stm.mark = null;
        }

        switch (mark_type) {
        case "clear":
            // XXX: Check this is the right place.
            // doc.setCursor(stm.start);
            break;
        case "processing":
            this.markWithClass(stm, 'coq-eval-pending');
            break;
        case "error":
            this.markWithClass(stm, 'coq-eval-failed');
            // XXX: Check this is the right place.
            this.editor.setCursor(stm.end);
            break;
        case "ok":
            this.markWithClass(stm, 'coq-eval-ok');
            // XXX: Check this is the right place.
            // This interferes with the go to target.
            // doc.setCursor(stm.end);
            break;
        }
    }

    highlight(stm, flag) {
        if (stm.mark) {
            let b = stm.mark.find();
            stm.start = b.from; stm.end = b.to;
            var new_class = 
                stm.mark.className.replace(/( coq-highlight)?$/, flag ? ' coq-highlight' : '')
            if (new_class != stm.mark.className) {
                stm.mark.clear(); this._unmarkWidgets(stm.start, stm.end);
                this.markWithClass(stm, new_class);
            }
        }
    }

    markWithClass(stm, className) {
        var doc = this.editor.getDoc();

        var mark = 
            doc.markText(stm.start, stm.end, {className: className,
                attributes: {'data-coq-sid': stm.coq_sid}});

        this._markWidgetsAsWell(stm.start, stm.end, mark);

        mark.stm = stm;
        stm.mark = mark;
    }

    /**
     * Hack to apply MarkedSpan CSS class formatting and attributes to widgets
     * within mark boundaries as well. 
     * (This is not handled by the native CodeMirror#markText.)
     */
    _markWidgetsAsWell(start, end, mark) {
        var classNames = mark.className.split(/ +/);
        var attrs = mark.attributes || {};
        for (let w of this.editor.findMarks(start, end, x => x.widgetNode)) {
            for (let cn of classNames)
                w.widgetNode.classList.add(cn);
            for (let attr in attrs)
                w.widgetNode.setAttribute(attr, attrs[attr]);
        }
    }

    /** 
     * Hack contd: negates effects of _markWidgetsAsWell when mark is cleared.
     */
    _unmarkWidgets(start, end) {
        for (let w of this.editor.findMarks(start, end, x => x.widgetNode)) {
            for (let cn of [...w.widgetNode.classList]) {
                if (/^coq-/.exec(cn))
                    w.widgetNode.classList.remove(cn);
            }
            for (let attr of [...w.widgetNode.attributes]) {
                if (/^data-coq-/.exec(attr.name))
                    w.widgetNode.removeAttributeNode(attr);
            }
        }
    }

    getCursor() {
        return this.editor.getCursor();
    }

    cursorLess(c1, c2) {

        return (c1.line < c2.line ||
                (c1.line === c2.line && c1.ch < c2.ch));
    }

    cursorToStart(stm) {

        var doc = this.editor.getDoc();
        var csr = doc.getCursor();

        if (this.cursorLess(csr, stm.end))
            doc.setCursor(stm.start);
    }

    cursorToEnd(stm) {
        var doc = this.editor.getDoc();
        var csr = doc.getCursor();

        if (this.cursorLess(csr, stm.end))
            doc.setCursor(stm.end);
    }

    /**
     * Checks whether the range from start to end consists solely of
     * whitespaces.
     * @param {Pos} start starting position ({line, ch})
     * @param {Pos} end ending position ({line, ch})
     */
    onlySpacesBetween(start, end) {
        if (start.line > end.line) return true;
        var cur = {line: start.line, ch: start.ch};
        while (cur.line < end.line) {
            let cur_end = this.editor.getLine(cur.line).length,
                portion = this.editor.getRange(cur, {line: cur.line, ch: cur_end});
            if (!this._onlySpaces(portion)) return false;
            cur.line++;
            cur.ch = 0;
        }
        return this._onlySpaces(this.editor.getRange(cur, end));
    }

    _onlySpaces(str) {
        return !!(/^\s*$/.exec(str));
    }

    // If any marks, then call the invalidate callback!
    onCMChange(editor, evt) {

        var doc   = editor.getDoc();
        var marks = doc.getAllMarks();

        // Find the first mark that is at or after the change point
        for (let mark of marks) {
            let b = mark.find();
            if (mark.stm && this.cursorLess(evt.from, b.to)) {
                this.onInvalidate(mark.stm);
                break;
            }
        }
    }

    _markFromElement(dom) {
        var sid = dom.classList.contains('CodeMirror-line') ?
                    $(dom).find('[data-coq-sid]').last().attr('data-coq-sid')
                  : $(dom).attr('data-coq-sid');

        if (sid) {
            for (let mark of this.editor.getAllMarks()) {
                if (mark.stm && mark.stm.coq_sid == sid) {
                    return mark;
                }
            }
        }

        return undefined;
    }

    // If a mark is present, request contextual information.
    onCMMouseMove(evt) {

        var mark = this._markFromElement(evt.target);

        if (mark && this.hover.indexOf(mark) > -1) return;

        for (let m of this.hover)
            this.highlight(m.stm, false);

        if (mark) {
            this.hover = [mark];
            this.highlight(mark.stm, true);
            this.onMouseEnter(mark.stm, evt);
            if (!this._key_bound) {
                this._key_bound = true;
                $(document).on('keydown keyup', this._keyHandler);
            }
        }
        else {
            if (this.hover[0])
                this.onMouseLeave(this.hover[0].stm, evt);
            this.hover = [];
            $(document).off('keydown keyup', this._keyHandler);
            this._key_bound = false;
        }
    }

    // Notification of leaving the mark.
    onCMMouseLeave(evt) {
        if (this.hover.length > 0) {
            for (let m of this.hover)
                this.highlight(m.stm, false);
            this.onMouseLeave(this.hover[0].stm, evt);
            this.hover = [];
        }
    }

    keyHandler(evt) {
        if (this.hover[0])
            this.onMouseEnter(this.hover[0].stm, evt);
    }


    // CM specific functions.

    // Returns the next token after the one seen at position: {line:…, ch:…}
    // type_re: regexp to match token type.
    // The returned object is a CodeMirror token with an additional attribute 'line'.
    getNextToken(position, type_re) {
        var cm = this.editor;
        var linecount = cm.getDoc().lineCount();
        var token, next, ch, line;
        do {
            token = cm.getTokenAt(position);
            ch = token.end + 1;
            line = position.line;
            if (token.end === cm.getLine(line).length) {
                line++;
                ch = 0;
                if (line >= linecount)
                    return null;
            }
            next = cm.getTokenAt({line:line, ch:ch});
            next.line = line;
            position = {line:next.line, ch:next.end};
        } while(type_re && !(type_re.test(next.type)));
        return next;
    }

}

// Local Variables:
// js-indent-level: 4
// End:
