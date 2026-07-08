import React from "react";
import PropTypes from "prop-types";
import debounce from "lodash.debounce";
import * as cm from "codemirror";
import "codemirror/addon/edit/matchbrackets";
import "codemirror/addon/search/search";
import "codemirror/addon/search/searchcursor";
import "codemirror/addon/search/jump-to-line";
import "codemirror/addon/dialog/dialog";
import "codemirror/addon/selection/active-line";
import "../codemirror.css";
import "codemirror/addon/dialog/dialog.css";

export default class CodeMirror extends React.Component {

    static propTypes = {
        className: PropTypes.string,
        focus: PropTypes.bool,
        value: PropTypes.string,
        options: PropTypes.object,
        onBeforeChange: PropTypes.func,
        onChange: PropTypes.func,
        onKeyPress: PropTypes.func,
        linePos: PropTypes.number,
        cursorPosition: PropTypes.number,
    };

    render() {
        return (
            <div className={this.props.className}>
                <textarea ref={node => this.textarea = node}
                          autoFocus={this.props.focus}
                          autoComplete="off"/>
            </div>
        );
    }

    componentDidMount() {
        this.codeMirror = cm.fromTextArea(this.textarea, this.props.options);

        const value = this.props.value || '';
        this.codeMirror.setValue(value);
        // Undo must stop at the initial content, not the empty pre-load document.
        this.codeMirror.clearHistory();

        let char = 0;
        if (this.props.cursorPosition) {
            if (this.props.cursorPosition === -1) {
                char = value.length;
            } else {
                char = this.props.cursorPosition;
            }
        }

        const line = this.props.linePos && this.props.linePos === -1 ? this.codeMirror.lineCount() : 0;
        this.codeMirror.setCursor(line, char);

        this.codeMirror.on('beforeChange', (codeMirror, change) => this.cmBeforeChange(codeMirror, change));
        this.codeMirror.on('change', (codeMirror, change) => this.cmChange(codeMirror, change));
        this.codeMirror.on('keypress', (codeMirror, event) => this.props.onKeyPress && this.props.onKeyPress(codeMirror, event));
    }

    componentWillUnmount() {
        if (this.codeMirror) {
            this.codeMirror.toTextArea();
        }
    }

    getCodeMirror() {
        return this.codeMirror;
    }

    focus() {
        if (this.codeMirror) {
            this.codeMirror.focus();
        }
    }

    blur() {
        if (this.codeMirror) {
            this.codeMirror.getInputField().blur();
        }
    }

    cmBeforeChange(codeMirror, change) {
        if (this.props.onBeforeChange && change.origin !== 'setValue') {
            this.props.onBeforeChange(codeMirror, change);
        }
    }

    cmChange(codeMirror, change) {
        if (this.props.onChange && change.origin !== 'setValue') {
            this.props.onChange(codeMirror, change);
        }
    }

    UNSAFE_componentWillMount() {
        this.UNSAFE_componentWillReceiveProps = debounce(this.UNSAFE_componentWillReceiveProps, 0);
    }

    UNSAFE_componentWillReceiveProps(nextProps) {
        if (!this.codeMirror) return;

        // Changing value
        if (nextProps.value !== undefined) {

            const newValue = nextProps.value.replace(/\r\n|\r/g, '\n');
            const oldValue = this.codeMirror.getValue().replace(/\r\n|\r/g, '\n');
            if (newValue !== oldValue) {
                const prevScrollPosition = this.codeMirror.getScrollInfo();
                this.codeMirror.setValue(nextProps.value);
                this.codeMirror.scrollTo(prevScrollPosition.left, prevScrollPosition.top);
            }

            let char = 0;
            if (nextProps.formulaPosition) {
                if (nextProps.formulaPosition === -1) {
                    char = newValue.length;
                } else {
                    char = nextProps.formulaPosition;
                }
            }

            const line = nextProps.linePos && nextProps.linePos === -1 ? this.codeMirror.lineCount() : 0;
            this.codeMirror.setCursor(line, char);
        }

        // Changing options
        if (typeof nextProps.options === 'object') {
            for (let optionName in nextProps.options) {
                if (nextProps.options.hasOwnProperty(optionName)) {
                    this.codeMirror.setOption(optionName, nextProps.options[optionName]);
                }
            }
        }

        if (nextProps.focus) {
            this.focus();
        }

        if (nextProps.blur) {
            this.blur();
        }
    }
}
