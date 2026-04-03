import * as params from '@params';

let fuse;
let resList = document.getElementById('searchResults');
let sInput = document.getElementById('searchInput');
let first, last, current_elem = null
let resultsAvailable = false;

// Escape HTML for safe innerHTML insertion
function esc(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Wrap Fuse.js match indices with <mark> tags
function highlight(str, indices) {
    if (!indices || !indices.length) return esc(str);
    let out = '', pos = 0;
    for (const [s, e] of indices) {
        out += esc(str.slice(pos, s));
        out += '<mark>' + esc(str.slice(s, e + 1)) + '</mark>';
        pos = e + 1;
    }
    return out + esc(str.slice(pos));
}

// Extract a short snippet around the first match, with highlighting applied
function getSnippet(str, indices, radius) {
    radius = radius || 90;
    if (!str) return '';
    if (!indices || !indices.length) {
        return esc(str.slice(0, 180)) + (str.length > 180 ? '…' : '');
    }
    const [s0, e0] = indices[0];
    const start = Math.max(0, s0 - radius);
    const end   = Math.min(str.length, e0 + radius + 1);
    let out = start > 0 ? '…' : '', pos = start;
    for (const [s, e] of indices) {
        if (s >= end) break;
        if (e < start) continue;
        const cs = Math.max(s, start), ce = Math.min(e + 1, end);
        out += esc(str.slice(pos, cs));
        out += '<mark>' + esc(str.slice(cs, ce)) + '</mark>';
        pos = ce;
    }
    out += esc(str.slice(pos, end));
    if (end < str.length) out += '…';
    return out;
}

// Load index immediately — don't wait for window.onload which is blocked by
// slow external resources (fonts, analytics, etc.)
(function initSearch() {
    let xhr = new XMLHttpRequest();
    xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) {
            if (xhr.status === 200) {
                let data = JSON.parse(xhr.responseText);
                if (data) {
                    let options = {
                        distance: 100,
                        threshold: 0.4,
                        ignoreLocation: true,
                        includeMatches: true,
                        keys: [
                            'title',
                            'permalink',
                            'summary',
                            'content'
                        ]
                    };
                    if (params.fuseOpts) {
                        options = {
                            isCaseSensitive: params.fuseOpts.iscasesensitive ?? false,
                            includeScore: params.fuseOpts.includescore ?? false,
                            includeMatches: params.fuseOpts.includematches ?? true,
                            minMatchCharLength: params.fuseOpts.minmatchcharlength ?? 1,
                            shouldSort: params.fuseOpts.shouldsort ?? true,
                            findAllMatches: params.fuseOpts.findallmatches ?? false,
                            keys: params.fuseOpts.keys ?? ['title', 'permalink', 'summary', 'content'],
                            location: params.fuseOpts.location ?? 0,
                            threshold: params.fuseOpts.threshold ?? 0.4,
                            distance: params.fuseOpts.distance ?? 100,
                            ignoreLocation: params.fuseOpts.ignorelocation ?? true
                        }
                    }
                    fuse = new Fuse(data, options);
                }
            } else {
                console.log(xhr.responseText);
            }
        }
    };
    xhr.open('GET', "../index.json");
    xhr.send();
})();

function activeToggle(ae) {
    document.querySelectorAll('.focus').forEach(function (element) {
        element.classList.remove("focus")
    });
    if (ae) {
        ae.focus()
        document.activeElement = current_elem = ae;
        ae.parentElement.classList.add("focus")
    } else {
        document.activeElement.parentElement.classList.add("focus")
    }
}

function reset() {
    resultsAvailable = false;
    resList.innerHTML = sInput.value = '';
    sInput.focus();
}

sInput.onkeyup = function (e) {
    if (fuse) {
        let results;
        if (params.fuseOpts) {
            results = fuse.search(this.value.trim(), {limit: params.fuseOpts.limit});
        } else {
            results = fuse.search(this.value.trim());
        }
        if (results.length !== 0) {
            let resultSet = '';

            for (let item in results) {
                const r = results[item];

                // Build key → indices map from Fuse match data
                const mIdx = {};
                (r.matches || []).forEach(m => { mIdx[m.key] = m.indices; });

                // Title with match highlights
                const titleHtml = highlight(r.item.title, mIdx['title']);

                // Content snippet: prefer a match in body content, then summary
                let bodyHtml = '';
                if (mIdx['content'] && r.item.content) {
                    bodyHtml = getSnippet(r.item.content, mIdx['content']);
                } else if (mIdx['summary'] && r.item.summary) {
                    bodyHtml = getSnippet(r.item.summary, mIdx['summary']);
                } else if (r.item.summary) {
                    const s = r.item.summary;
                    bodyHtml = esc(s.slice(0, 180)) + (s.length > 180 ? '…' : '');
                }

                resultSet +=
                    `<li class="post-entry revealed">` +
                    `<header class="entry-header">${titleHtml}&nbsp;»</header>` +
                    (bodyHtml ? `<div class="entry-content"><p>${bodyHtml}</p></div>` : '') +
                    `<a href="${esc(r.item.permalink)}" aria-label="${esc(r.item.title)}"></a>` +
                    `</li>`;
            }

            resList.innerHTML = resultSet;
            resultsAvailable = true;
            first = resList.firstChild;
            last = resList.lastChild;
        } else {
            resultsAvailable = false;
            resList.innerHTML = '';
        }
    }
}

sInput.addEventListener('search', function (e) {
    if (!this.value) reset()
})

document.onkeydown = function (e) {
    let key = e.key;
    let ae = document.activeElement;

    let inbox = document.getElementById("searchbox").contains(ae)

    if (ae === sInput) {
        let elements = document.getElementsByClassName('focus');
        while (elements.length > 0) {
            elements[0].classList.remove('focus');
        }
    } else if (current_elem) ae = current_elem;

    if (key === "Escape") {
        reset()
    } else if (!resultsAvailable || !inbox) {
        return
    } else if (key === "ArrowDown") {
        e.preventDefault();
        if (ae == sInput) {
            activeToggle(resList.firstChild.lastChild);
        } else if (ae.parentElement != last) {
            activeToggle(ae.parentElement.nextSibling.lastChild);
        }
    } else if (key === "ArrowUp") {
        e.preventDefault();
        if (ae.parentElement == first) {
            activeToggle(sInput);
        } else if (ae != sInput) {
            activeToggle(ae.parentElement.previousSibling.lastChild);
        }
    } else if (key === "ArrowRight") {
        ae.click();
    }
}
