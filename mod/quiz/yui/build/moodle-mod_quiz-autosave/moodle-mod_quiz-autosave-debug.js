YUI.add('moodle-mod_quiz-autosave', function (Y, NAME) {

// This file is part of Moodle - http://moodle.org/
//
// Moodle is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Moodle is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with Moodle.  If not, see <http://www.gnu.org/licenses/>.


/**
 * Auto-save functionality for during quiz attempts.
 *
 * @package   mod_quiz
 * @copyright 1999 onwards Martin Dougiamas  {@link http://moodle.com}
 * @license   http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

M.mod_quiz = M.mod_quiz || {};
M.mod_quiz.autosave = {
    /** Delays and repeat counts. */
    TINYMCE_DETECTION_DELAY:  500,
    TINYMCE_DETECTION_REPEATS: 20,
    WATCH_HIDDEN_DELAY:      1000,

    /** Selectors. */
    SELECTORS: {
        QUIZ_FORM:             '#responseform',
        VALUE_CHANGE_ELEMENTS: 'input, textarea',
        CHANGE_ELEMENTS:       'input, select',
        HIDDEN_INPUTS:         'input[type=hidden]'
    },

    /** Script that handles the auto-saves. */
    AUTOSAVE_HANDLER: M.cfg.wwwroot + '/mod/quiz/autosave.ajax.php',

    /** The delay between a change being made, and it being auto-saved. */
    delay: 120000,

    /** The form we are monitoring. */
    form: null,

    /** Whether the form has been modified since the last save started. */
    dirty: false,

    /** Timer object for the delay between form modifaction and the save starting. */
    delay_timer: null,

    /** Y.io transaction for the save ajax request. */
    save_transaction: null,

    /** Properly bound key change handler. */
    editor_change_handler: null,

    hidden_field_values: {},

    /**
     * Initialise the autosave code.
     * @param delay the delay, in seconds, between a change being detected, and
     * a save happening.
     */
    init: function(delay) {
        this.form = Y.one(this.SELECTORS.QUIZ_FORM);
        if (!this.form) {
            Y.log('No response form found. Why did you try to set up autosave?');
            return;
        }

        this.delay = delay * 1000;

        this.form.delegate('valuechange', this.value_changed, this.SELECTORS.VALUE_CHANGE_ELEMENTS, this);
        this.form.delegate('change',      this.value_changed, this.SELECTORS.CHANGE_ELEMENTS,       this);
        this.form.on('submit', this.stop_autosaving, this);

        this.init_tinymce(this.TINYMCE_DETECTION_REPEATS);

        this.save_hidden_field_values();
        this.watch_hidden_fields();
        this.restore_saved_data();
    },

    save_hidden_field_values: function() {
        this.form.all(this.SELECTORS.HIDDEN_INPUTS).each(function(hidden) {
            var name  = hidden.get('name');
            if (!name) {
                return;
            }
            this.hidden_field_values[name] = hidden.get('value');
        }, this);
    },

    watch_hidden_fields: function() {
        this.detect_hidden_field_changes();
        Y.later(this.WATCH_HIDDEN_DELAY, this, this.watch_hidden_fields);
    },

    detect_hidden_field_changes: function() {
        this.form.all(this.SELECTORS.HIDDEN_INPUTS).each(function(hidden) {
            var name  = hidden.get('name'),
                value = hidden.get('value');
            if (!name) {
                return;
            }
            if (!(name in this.hidden_field_values) || value !== this.hidden_field_values[name]) {
                this.hidden_field_values[name] = value;
                this.value_changed({target: hidden});
            }
        }, this);
    },

    /**
     * @param repeatcount Because TinyMCE might load slowly, after us, we need
     * to keep trying every 10 seconds or so, until we detect TinyMCE is there,
     * or enough time has passed.
     */
    init_tinymce: function(repeatcount) {
        if (typeof tinyMCE === 'undefined') {
            if (repeatcount > 0) {
                Y.later(this.TINYMCE_DETECTION_DELAY, this, this.init_tinymce, [repeatcount - 1]);
            } else {
                Y.log('Gave up looking for TinyMCE.');
            }
            return;
        }

        Y.log('Found TinyMCE.');
        this.editor_change_handler = Y.bind(this.editor_changed, this);
        tinyMCE.onAddEditor.add(Y.bind(this.init_tinymce_editor, this));
    },

    /**
     * @param repeatcount Because TinyMCE might load slowly, after us, we need
     * to keep trying every 10 seconds or so, until we detect TinyMCE is there,
     * or enough time has passed.
     */
    init_tinymce_editor: function(notused, editor) {
        Y.log('Found TinyMCE editor ' + editor.id + '.');
        editor.onChange.add(this.editor_change_handler);
        editor.onRedo.add(this.editor_change_handler);
        editor.onUndo.add(this.editor_change_handler);
        editor.onKeyDown.add(this.editor_change_handler);
    },

    value_changed: function(e) {
        if (e.target.get('name') === 'thispage' || e.target.get('name') === 'scrollpos' ||
                e.target.get('name').match(/_:flagged$/)) {
            return; // Not interesting.
        }
        Y.log('Detected a value change in element ' + e.target.get('name') + '.');
        this.save_locally(e.target.get('name'), e.target.get('value'), e.target.get('type'));
        this.start_save_timer_if_necessary();
    },

    /**
     * Save field values using local storage api.
     * @param string key field name
     * @param mixed value field value
     * @param string type field type
     */
    save_locally: function(key, value, type){
//        window.localStorage.clear();
        // initialise variables.
        var question_id, sequence_id, sequence_value, data, saved, field_name;
        
        // Get sequence id.
        question_id = this.get_form_question_prefix_from_id(key);
        sequence_id = question_id+'_:sequencecheck';

        // Get current sequence value.
        sequence_value = this.hidden_field_values[sequence_id];
        
        // Get saved data.
        data = this.get_saved_question_data(question_id);
        
        // Clear old values.
        if(data && (data.sequencecheck !== sequence_value)){
            data=null;
            Y.log('Clear old sequence data');
        }

        // If data doesn't exist. Create it.
        if(!data || !data.fields){
            data = {
                    "sequencecheck": sequence_value,
                    "fields": {}
                };
        }

        // Update the field
        field_name = this.get_form_question_field_name_from_id(key);

        switch(type){
            case 'checkbox':
                // Checkbox value is whether they're checked or not.
                value = Y.one('[id^="'+question_id+'_'+field_name+'"]').get('checked')?1:0;
                break;
            case 'editor':
                // Editors have a name suffix '_id'. The related textareas don't.
                field_name = field_name.substr(0, field_name.indexOf('_id'));
                break;
            
        }
        data.fields[field_name] = value;
        
        // Save data string.
        window.localStorage.setItem(question_id, Y.JSON.stringify(data));
    },
    
    /**
     * Get the current locally saved question data?
     * @param id
     */
    get_saved_question_data: function(id){
        var data, saved;
        try {
            saved = window.localStorage.getItem(id);
            if(!saved){
                Y.log('No local stored data exists for question id: ' + id);
                return data;
            }
            data = Y.JSON.parse(saved);
            Y.log('Loaded local stored data for question id: ' + id);
        }
        catch (e) {
            Y.log('Unable to load local stored data for question id: ' + id);
        }
        
        return data;
    },
    
    get_form_question_prefix_from_id: function(id){
        return id.substring(0, id.indexOf('_'));
    },
    
    get_form_question_field_name_from_id: function(id){
        return id.substring(id.indexOf('_')+1);
    },
    
    restore_saved_data: function() {
        var question_id, key, check_value, data;
        // loop sequencecheck fields
        for(key in this.hidden_field_values){
            var index = key.indexOf('sequencecheck');
            if(key.indexOf('sequencecheck')<0){
               continue; 
            }
            Y.log('restore data for key '+key);
            
            check_value = this.hidden_field_values[key];
            question_id = this.get_form_question_prefix_from_id(key);
            
            // Get stored data.
            data = this.get_saved_question_data(question_id);
            
            // Is there any data?
            if(!data || !data.fields){
                // No data or data fields stored.
                continue;
            }
            
            // Is the data current? Match current sequence check.
            if(data.sequencecheck !== check_value){
                continue;
            }
            
            data.autosave = this;
            // Data is current. Now restore it.
            for(var field_id in data.fields){
                var name = '[name^="'+question_id+'_'+field_id+'"]';
                var fields = this.form.all(name).each(this.update_field_value_with_saved, data);
            }
            
        }
    },
    
    update_field_value_with_saved: function(field){
        var name  = this.autosave.get_form_question_field_name_from_id(field.get('name'));
        //Y.log('name = '+name);
        
        var type  = field.get('type');
        //Y.log('type = '+type);
        var value = this.fields[name];
        
        switch(field.get('type')){
            case "text":
                field.set('value', value);
                break;
            case "radio":
                // Radio inputs have multiple fields with the same name and only one selected.
                
                // Only set the field with the correct value.
                if(field.get('value')!==value){
                    return;
                }
                field.set('checked', 'checked');
                break;
            case "textarea":
                field.set('value', value);
                break;
            case "checkbox":
                field.set('checked', value);
                break;
            case "select-one":
                var option = field.one('option[value="'+value+'"]');
                if(option){
                    option.set('selected', 1);
                }
                break;
        }
    },

    editor_changed: function(editor) {
        Y.log('Detected a value change in editor ' + editor.id + '.');
        Y.log('value change to' + editor.getContent() + '.');
        this.save_locally(editor.id, editor.getContent(), 'editor');
        this.start_save_timer_if_necessary();
    },

    start_save_timer_if_necessary: function() {
        this.dirty = true;

        if (this.delay_timer || this.save_transaction) {
            // Already counting down or daving.
            return;
        }

        this.start_save_timer();
    },

    start_save_timer: function() {
        this.cancel_delay();
        this.delay_timer = Y.later(this.delay, this, this.save_changes);
    },

    cancel_delay: function() {
        if (this.delay_timer && this.delay_timer !== true) {
            this.delay_timer.cancel();
        }
        this.delay_timer = null;
    },

    save_changes: function() {
        this.cancel_delay();
        this.dirty = false;

        if (this.is_time_nearly_over()) {
            Y.log('No more saving, time is nearly over.');
            this.stop_autosaving();
            return;
        }

        Y.log('Doing a save.');
        if (typeof tinyMCE !== 'undefined') {
            tinyMCE.triggerSave();
        }
        this.save_transaction = Y.io(this.AUTOSAVE_HANDLER, {
            method:  'POST',
            form:    {id: this.form},
            on:      {complete: this.save_done},
            context: this
        });
    },

    save_done: function() {
        Y.log('Save completed.');
        this.save_transaction = null;

        if (this.dirty) {
            Y.log('Dirty after save.');
            this.start_save_timer();
        }
    },

    is_time_nearly_over: function() {
        return M.mod_quiz.timer && M.mod_quiz.timer.endtime &&
                (new Date().getTime() + 2*this.delay) > M.mod_quiz.timer.endtime;
    },

    stop_autosaving: function() {
        this.cancel_delay();
        this.delay_timer = true;
        if (this.save_transaction) {
            this.save_transaction.abort();
        }
    }
};


}, '@VERSION@', {
    "requires": [
        "base",
        "node",
        "event",
        "event-valuechange",
        "node-event-delegate",
        "io-form",
        "json-parse",
        "json-stringify"
    ]
});
