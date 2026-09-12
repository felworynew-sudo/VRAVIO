/* VRAVIO boundary adapter for the bundled, unmodified AudioMass application.
 * The parent and this document share one origin, but an explicit origin check
 * remains important: this page accepts a File and hands it to Web Audio. */
(function (window) {
	'use strict';
	var pending = null;
	var currentLanguage = 'en';
	var translationObserver = null;
	var translations = [
		['Drag and Drop Audio Files in this window, or click', 'Перетащите аудиофайлы в это окно или нажмите'],
		['Drag n drop an Audio File in this window, or click', 'Перетащите аудиофайл в это окно или нажмите'],
		['here to use a sample', 'здесь, чтобы открыть пример'],
		['Stop Playback (Space)', 'Остановить воспроизведение (Пробел)'],
		['Pause (Shift+Space)', 'Пауза (Shift+Пробел)'],
		['Toggle Loop (L)', 'Циклическое воспроизведение (L)'],
		['Seek Start (Shift + left arrow)', 'В начало (Shift + стрелка влево)'],
		['Seek End (Shift + right arrow)', 'В конец (Shift + стрелка вправо)'],
		['Seek (left arrow)', 'Назад (стрелка влево)'],
		['Seek (right arrow)', 'Вперёд (стрелка вправо)'],
		['Copy Selection (Shift + C)', 'Копировать выделение (Shift + C)'],
		['Paste Selection (Shift + V)', 'Вставить выделение (Shift + V)'],
		['Cut Selection (Shift + X)', 'Вырезать выделение (Shift + X)'],
		['Insert Silence (Shift + N)', 'Вставить тишину (Shift + N)'],
		['Clear Selection (Q key)', 'Снять выделение (Q)'],
		['Speed Up / Slow Down (pitch)', 'Ускорение / замедление (высота тона)'],
		['Apply Delay to selected range', 'Применить задержку к выделенному диапазону'],
		['Apply Distortion to selected range', 'Применить искажение к выделенному диапазону'],
		['Apply Reverb to selected range', 'Применить реверберацию к выделенному диапазону'],
		['Noise Reduction (Voice)', 'Шумоподавление (голос)'],
		['Audio Repair is not available in multitrack', 'Восстановление аудио недоступно в мультитреке'],
		['Choose an MP3 file inside this window first', 'Сначала выберите MP3-файл в этом окне'],
		['Please allow pop-ups for the audio editor!', 'Разрешите всплывающие окна для аудиоредактора!'],
		['Analyzing audio. This can take a while on long files.', 'Анализ аудио. Для длинных файлов это может занять время.'],
		['Preparing audio for background analysis...', 'Подготовка аудио к фоновому анализу...'],
		['Loading tempo detector...', 'Загрузка анализатора темпа...'],
		['Please type a name, eg: My Preset', 'Введите название, например: Мой пресет'],
		['The prior session could not be transferred automatically.', 'Предыдущую сессию не удалось перенести автоматически.'],
		['Open or append', 'Открыть или добавить'],
		['ADD IN EXISTING', 'ДОБАВИТЬ В ТЕКУЩИЙ'],
		['OPEN IN NEW WINDOW', 'ОТКРЫТЬ В НОВОМ ОКНЕ'],
		['OPEN IN NEW', 'ОТКРЫТЬ В НОВОМ'],
		['OPEN NEW', 'ОТКРЫТЬ НОВЫЙ'],
		['Open in New Editor', 'Открыть в новом редакторе'],
		['Open in Existing?', 'Открыть в текущем?'],
		['Open Offline Version?', 'Открыть автономную версию?'],
		['Export / Download', 'Экспорт / загрузка'],
		['Load from Computer', 'Открыть с компьютера'],
		['Load Sample File', 'Открыть пример'],
		['Load From URL', 'Открыть по URL'],
		['Load audio from remote url', 'Открыть аудио по внешнему URL'],
		['Save Draft Locally', 'Сохранить черновик локально'],
		['Save Local Draft of...', 'Сохранить локальный черновик...'],
		['Open Local Drafts', 'Открыть локальные черновики'],
		['Succesfully Stored', 'Успешно сохранено'],
		['No drafts found...', 'Черновики не найдены...'],
		['New Recording', 'Новая запись'],
		['Frequency Analyser', 'Анализатор частот'],
		['Spectrum Analyser', 'Анализатор спектра'],
		['Multitrack Mixer', 'Мультитрековый микшер'],
		['Tempo & Rhythm Tools', 'Инструменты темпа и ритма'],
		['Tempo Tools', 'Инструменты темпа'],
		['Center to Cursor', 'Центрировать по курсору'],
		['Store Offline Version', 'Сохранить автономную версию'],
		['Update Offline Version', 'Обновить автономную версию'],
		['Downloading newer version', 'Загрузка новой версии'],
		['SourceCode on Github', 'Исходный код на GitHub'],
		['See Welcome Message', 'Показать приветствие'],
		['Channel Info/Flip', 'Сведения о канале / инверсия'],
		['Zero Cross Selection', 'Привязка выделения к нулю'],
		['Follow Cursor', 'Следовать за курсором'],
		['Peak Separators', 'Разделители пиков'],
		['Graphic EQ (20 bands)', 'Графический эквалайзер (20 полос)'],
		['Graphic EQ', 'Графический эквалайзер'],
		['Paragraphic EQ', 'Параграфический эквалайзер'],
		['Hard Limiting', 'Жёсткий лимитер'],
		['Hard Limiter', 'Жёсткий лимитер'],
		['Speed / Playback Rate', 'Скорость воспроизведения'],
		['Remove Silence', 'Удалить тишину'],
		['Seamless Loop', 'Бесшовный цикл'],
		['Preview Loop', 'Прослушать цикл'],
		['Audio Repair', 'Восстановление аудио'],
		['ID3 Tag Editor', 'Редактор тегов ID3'],
		['ID3 Tags', 'Теги ID3'],
		['DOWNLOAD COPY', 'СКАЧАТЬ КОПИЮ'],
		['Zoom In Horiz (+)', 'Увеличить по горизонтали (+)'],
		['Zoom Out Horiz (-)', 'Уменьшить по горизонтали (-)'],
		['Zoom In Vertically', 'Увеличить по вертикали'],
		['Zoom Out Vertically', 'Уменьшить по вертикали'],
		['Reset Zoom (0)', 'Сбросить масштаб (0)'],
		['Toggle Beat Markers', 'Показать маркеры долей'],
		['Snap to Beat Markers', 'Привязка к маркерам долей'],
		['Time Signature', 'Размер такта'],
		['Add Channel', 'Добавить канал'],
		['Delete Channel', 'Удалить канал'],
		['Clear Mute', 'Снять отключение'],
		['Clear Solo', 'Снять соло'],
		['Rec Trigger', 'Запуск записи'],
		['Pan L/R', 'Панорама Л/П'],
		['Selection:', 'Выделение:'],
		['Duration:', 'Длительность:'],
		['Start:', 'Начало:'],
		['End:', 'Конец:'],
		['clear selection', 'снять выделение'],
		['CHANNELS', 'КАНАЛЫ'],
		['Channels', 'Каналы'],
		['Please Wait...', 'Пожалуйста, подождите...'],
		['Nothing to export', 'Нечего экспортировать'],
		['Canceled Loading', 'Загрузка отменена'],
		['Loaded Successfully', 'Успешно загружено'],
		['Copied range', 'Диапазон скопирован'],
		['Inserted Silence', 'Тишина вставлена'],
		['Selection too short', 'Выделение слишком короткое'],
		['Could not load session', 'Не удалось открыть сессию'],
		['Could not apply Speed', 'Не удалось применить изменение скорости'],
		['Could not analyze audio.', 'Не удалось проанализировать аудио.'],
		['Nothing to estimate', 'Нечего анализировать'],
		['Make a selection first', 'Сначала создайте выделение'],
		['Load audio first', 'Сначала откройте аудио'],
		['Reading metadata...', 'Чтение метаданных...'],
		['Unsupported audio file.', 'Неподдерживаемый аудиофайл.'],
		['Successfully deleted preset!', 'Пресет удалён!'],
		['Successfully updated preset!', 'Пресет обновлён!'],
		['Successfully saved preset!', 'Пресет сохранён!'],
		['Name is too short...', 'Название слишком короткое...'],
		['Measuring...', 'Измерение...'],
		['Working...', 'Обработка...'],
		['Apply: Match', 'Применить: выровнять до'],
		['Apply EQ', 'Применить эквалайзер'],
		['Apply Gain', 'Применить усиление'],
		['Apply', 'Применить'],
		['Cancel', 'Отмена'],
		['cancel', 'отмена'],
		['Save As New', 'Сохранить как новый'],
		['Save', 'Сохранить'],
		['Delete', 'Удалить'],
		['Update', 'Обновить'],
		['Estimate', 'Оценить'],
		['Reset', 'Сбросить'],
		['Export', 'Экспортировать'],
		['Load Asset', 'Открыть ресурс'],
		['Invalid URL entered', 'Введён неверный URL'],
		['Please insert url', 'Введите URL'],
		['(optional) filename', 'Имя файла (необязательно)'],
		['mp3 filename', 'Имя MP3-файла'],
		['New Recording', 'Новая запись'],
		['Deselect All', 'Снять выделение'],
		['Select All', 'Выделить всё'],
		['Fade In', 'Плавное появление'],
		['Fade Out', 'Плавное затухание'],
		['Compressor', 'Компрессор'],
		['Normalize', 'Нормализация'],
		['Distortion', 'Искажение'],
		['Reverb', 'Реверберация'],
		['Reverse', 'Реверс'],
		['Invert', 'Инвертировать'],
		['Delay', 'Задержка'],
		['Gain', 'Усиление'],
		['Timeline', 'Шкала времени'],
		['Volume', 'Уровень громкости'],
		['Mute', 'Отключить'],
		['Solo', 'Соло'],
		['Record (R)', 'Запись (R)'],
		['Play (Space)', 'Воспроизвести (Пробел)'],
		['Play', 'Воспроизвести'],
		['Stop', 'Стоп'],
		['Undo', 'Отменить'],
		['Redo', 'Повторить'],
		['Effects', 'Эффекты'],
		['View', 'Просмотр'],
		['Help', 'Справка'],
		['About', 'О программе'],
		['Edit', 'Правка'],
		['File', 'Файл'],
		['My Preset', 'Мой пресет'],
		['Old Telephone', 'Старый телефон'],
		['Telephone', 'Телефон'],
		['Old Radio', 'Старое радио'],
		['Megaphone', 'Мегафон'],
		['Underwater', 'Под водой'],
		['Bass Boost', 'Усиление баса'],
		['Treble Boost', 'Усиление высоких частот'],
		['Vocal Presence', 'Выразительность вокала'],
		['Vocal Clarity', 'Чёткость вокала'],
		['Podcast Voice', 'Голос для подкаста'],
		['Podcast', 'Подкаст'],
		['Loudness', 'Громкость'],
		['Air / Brilliance', 'Воздух / яркость'],
		['De-Rumble', 'Удаление низкочастотного гула'],
		['De-Hiss', 'Удаление шипения'],
		['De-Esser', 'Деэссер'],
		['Drum Punch', 'Атака барабанов'],
		['Acoustic Sparkle', 'Яркость акустики'],
		['Acoustic', 'Акустика'],
		['Rumble Cut', 'Срез гула'],
		['Lo-Fi / Vintage', 'Lo-Fi / винтаж'],
		['Lo Fi', 'Lo-Fi'],
		['Hip Hop', 'Хип-хоп'],
		['Bright', 'Яркий'],
		['Warm', 'Тёплый'],
		['Air', 'Воздух'],
		['Small Room', 'Малая комната'],
		['Medium Room', 'Средняя комната'],
		['Large Hall', 'Большой зал'],
		['Cathedral', 'Собор'],
		['Vocal Booth', 'Вокальная кабина'],
		['Drum Chamber', 'Барабанная комната'],
		['Ambient Wash', 'Атмосферный фон'],
		['Tight Slap', 'Короткое эхо'],
		['Spacey', 'Пространственный'],
		['Classic', 'Классический'],
		['Plate', 'Пластина'],
		['Cave', 'Пещера'],
		['Beta', 'Бета'],
		['Space', 'Пробел'],
		['BEAT', 'ДОЛИ'],
		['SNAP', 'ПРИВ'],
		['VOL', 'ГРОМ'],
		['L/R', 'Л/П'],
		['clear', 'очистить'],
		['ON', 'ВКЛ'],
		['OFF', 'ВЫКЛ'],
		['BPM', 'УД/МИН']
	];
	var toRussian = translations.slice().sort(function (a, b) { return b[0].length - a[0].length; });
	var toEnglish = translations.slice().sort(function (a, b) { return b[1].length - a[1].length; });

	function translateValue(value, language) {
		var result = String(value == null ? '' : value);
		var list = language === 'ru' ? toRussian : toEnglish;
		var fromIndex = language === 'ru' ? 0 : 1;
		var toIndex = language === 'ru' ? 1 : 0;
		for (var i = 0; i < list.length; i++) {
			if (result.indexOf(list[i][fromIndex]) !== -1) result = result.split(list[i][fromIndex]).join(list[i][toIndex]);
		}
		return result;
	}

	function translateNode(node) {
		if (!node) return;
		if (node.nodeType === 3) {
			var parent = node.parentNode;
			if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/i.test(parent.nodeName)) return;
			var translated = translateValue(node.nodeValue, currentLanguage);
			if (translated !== node.nodeValue) node.nodeValue = translated;
			return;
		}
		if (node.nodeType === 1) {
			['title', 'aria-label', 'placeholder'].forEach(function (attribute) {
				if (!node.hasAttribute(attribute)) return;
				var value = node.getAttribute(attribute);
				var translated = translateValue(value, currentLanguage);
				if (translated !== value) node.setAttribute(attribute, translated);
			});
			if (node.tagName === 'INPUT' && /^(Channel|Канал) \d+$/.test(node.value)) {
				node.value = currentLanguage === 'ru' ? node.value.replace(/^Channel /, 'Канал ') : node.value.replace(/^Канал /, 'Channel ');
			}
		}
	}

	function translateTree(root) {
		if (!root || (root.nodeType !== 1 && root.nodeType !== 3 && root.nodeType !== 9 && root.nodeType !== 11)) return;
		translateNode(root);
		if (root.nodeType === 3) return;
		var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
		var nodes = [], node;
		while ((node = walker.nextNode())) nodes.push(node);
		for (var i = 0; i < nodes.length; i++) translateNode(nodes[i]);
	}

	function installTranslationObserver() {
		if (translationObserver) return;
		translationObserver = new MutationObserver(function (records) {
			for (var i = 0; i < records.length; i++) {
				if (records[i].type === 'characterData') translateTree(records[i].target);
				else {
					for (var j = 0; j < records[i].addedNodes.length; j++) translateTree(records[i].addedNodes[j]);
					if (records[i].type === 'attributes') translateTree(records[i].target);
				}
			}
		});
		translationObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['title', 'aria-label', 'placeholder'] });
	}
	function norm(value) {
		return String(value || '').replace(/\s+/g, ' ').replace(/[✓✔]/g, '').trim().toLowerCase();
	}
	function clickAudioMassCommand(menuName, itemName) {
		var headers = Array.prototype.slice.call(document.querySelectorAll('.pk_hdr > .pk_btn'));
		var header = headers.find(function (node) { return norm(translateValue(node.textContent, 'en')).indexOf(norm(menuName)) === 0; });
		if (!header) return;
		var menuButton = header.querySelector(':scope > button');
		if (menuButton) menuButton.click();
		window.requestAnimationFrame(function () {
			var items = Array.prototype.slice.call(header.querySelectorAll('.pk_menu button'));
			var wanted = norm(itemName);
			var item = items.find(function (node) { return norm(translateValue(node.textContent, 'en')).indexOf(wanted) === 0; });
			if (item && !item.disabled) item.click();
		});
	}
	function applyChrome(message) {
		var palette = message.palette || {};
		var root = document.documentElement;
		root.classList.add('vravio-embedded');
		currentLanguage = message.language === 'ru' ? 'ru' : 'en';
		root.lang = currentLanguage;
		var currentTitle = document.title.split(' — ')[0];
		if (!currentTitle || /^(VRAVIO|AudioMass)/i.test(currentTitle)) document.title = currentLanguage === 'ru' ? 'VRAVIO — Аудиоредактор' : 'VRAVIO — Audio Editor';
		else document.title = currentTitle + (currentLanguage === 'ru' ? ' — Аудио VRAVIO' : ' — VRAVIO Audio');
		root.style.colorScheme = message.theme === 'light' ? 'light' : 'dark';
		var tokens = {
			'--bg-0': palette.background, '--bg-1': palette.surface,
			'--bg-2': palette.raisedSurface, '--bg-3': palette.hoverSurface,
			'--bg-4': palette.hoverSurface, '--bd': palette.border,
			'--fg-0': palette.text, '--fg-1': palette.muted,
			'--fg-2': palette.muted, '--ac': palette.accent,
			'--ac-2': palette.accent, '--ac-soft': 'color-mix(in srgb, ' + palette.accent + ' 16%, transparent)',
			'--ac-glow': 'color-mix(in srgb, ' + palette.accent + ' 42%, transparent)'
		};
		Object.keys(tokens).forEach(function (key) { if (tokens[key]) root.style.setProperty(key, tokens[key]); });
		installTranslationObserver();
		translateTree(document.body);
	}
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
	// AudioMass has three separate call sites that build a Blob and drive it out
	// through a hidden <a download> + click() (actions.js's forceDownload for
	// WAV/MP3/FLAC export, ui-fx.js's ID3-tagged MP3 re-export, amss-format.js's
	// own .amss session save). Patching all three individually would mean this
	// bridge drifts from upstream every time one of them changes. One door
	// instead: intercept every such click here, regardless of which caller made
	// it. Only real decodable audio formats are relayed to the host — AudioMass's
	// own .amss session container is not audio and is left to download normally.
	var AUDIO_EXPORT_EXTENSION = /\.(wav|mp3|flac|ogg)$/i;
	var EXPORT_MIME_BY_EXTENSION = { wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg' };
	function relayExportToHost(blobUrl, filename) {
		fetch(blobUrl).then(function (response) { return response.arrayBuffer(); }).then(function (buffer) {
			var extension = (filename.split('.').pop() || '').toLowerCase();
			window.parent.postMessage({
				type: 'vravio:audiomass:export',
				filename: filename,
				mime: EXPORT_MIME_BY_EXTENSION[extension] || 'application/octet-stream',
				buffer: buffer
			}, window.location.origin, [buffer]);
		})['catch'](function () { /* best-effort relay; the browser download itself already succeeded */ });
	}
	function installExportInterceptor() {
		var proto = window.HTMLAnchorElement && window.HTMLAnchorElement.prototype;
		if (!proto || proto.__vravioExportPatched) return;
		proto.__vravioExportPatched = true;
		var nativeClick = proto.click;
		proto.click = function () {
			var filename = this.getAttribute('download');
			if (filename && AUDIO_EXPORT_EXTENSION.test(filename) && typeof this.href === 'string' && this.href.indexOf('blob:') === 0) {
				relayExportToHost(this.href, filename);
			}
			return nativeClick.apply(this, arguments);
		};
	}
	installExportInterceptor();
	window.addEventListener('message', function (event) {
		if (event.origin !== window.location.origin) return;
		if (event.data && event.data.type === 'vravio:audiomass:chrome') { applyChrome(event.data); return; }
		if (event.data && event.data.type === 'vravio:audiomass:command') { clickAudioMassCommand(event.data.menu, event.data.item); return; }
		openInAudioMass(event.data);
	});
	window.addEventListener('load', function () {
		if (pending) { var message = pending; pending = null; openInAudioMass(message); }
	});
})(window);
