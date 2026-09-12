/* VRAVIO boundary adapter for the bundled, unmodified AudioMass application.
 * The parent and this document share one origin, but an explicit origin check
 * remains important: this page accepts a File and hands it to Web Audio. */
(function (window) {
	'use strict';
	var pending = null;
	function openInAudioMass(message) {
		if (!message || message.type !== 'vravio:audiomass:open-file' || !message.file) return;
		var editor = window.PKAudioEditor;
		if (!editor || !editor.engine || !editor.engine.LoadArrayBuffer) {
			pending = message;
			return;
		}
		editor.engine.LoadArrayBuffer(message.file);
		if (message.file.name) document.title = message.file.name + ' — VRAVIO Audio';
	}
	window.addEventListener('message', function (event) {
		if (event.origin !== window.location.origin) return;
		openInAudioMass(event.data);
	});
	window.addEventListener('load', function () {
		if (pending) { var message = pending; pending = null; openInAudioMass(message); }
	});
})(window);
