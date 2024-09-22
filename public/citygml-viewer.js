(function (sax) {
  // wrapper for non-node envs
  sax.parser = function (strict, opt) {
    return new SAXParser(strict, opt);
  };
  sax.SAXParser = SAXParser;
  sax.SAXStream = SAXStream;
  sax.createStream = createStream;

  // When we pass the MAX_BUFFER_LENGTH position, start checking for buffer overruns.
  // When we check, schedule the next check for MAX_BUFFER_LENGTH - (max(buffer lengths)),
  // since that's the earliest that a buffer overrun could occur.  This way, checks are
  // as rare as required, but as often as necessary to ensure never crossing this bound.
  // Furthermore, buffers are only tested at most once per write(), so passing a very
  // large string into write() might have undesirable effects, but this is manageable by
  // the caller, so it is assumed to be safe.  Thus, a call to write() may, in the extreme
  // edge case, result in creating at most one complete copy of the string passed in.
  // Set to Infinity to have unlimited buffers.
  sax.MAX_BUFFER_LENGTH = 64 * 1024;

  var buffers = [
    "comment",
    "sgmlDecl",
    "textNode",
    "tagName",
    "doctype",
    "procInstName",
    "procInstBody",
    "entity",
    "attribName",
    "attribValue",
    "cdata",
    "script",
  ];

  sax.EVENTS = [
    "text",
    "processinginstruction",
    "sgmldeclaration",
    "doctype",
    "comment",
    "opentagstart",
    "attribute",
    "opentag",
    "closetag",
    "opencdata",
    "cdata",
    "closecdata",
    "error",
    "end",
    "ready",
    "script",
    "opennamespace",
    "closenamespace",
  ];

  function SAXParser(strict, opt) {
    if (!(this instanceof SAXParser)) {
      return new SAXParser(strict, opt);
    }

    var parser = this;
    clearBuffers(parser);
    parser.q = parser.c = "";
    parser.bufferCheckPosition = sax.MAX_BUFFER_LENGTH;
    parser.opt = opt || {};
    parser.opt.lowercase = parser.opt.lowercase || parser.opt.lowercasetags;
    parser.looseCase = parser.opt.lowercase ? "toLowerCase" : "toUpperCase";
    parser.tags = [];
    parser.closed = parser.closedRoot = parser.sawRoot = false;
    parser.tag = parser.error = null;
    parser.strict = !!strict;
    parser.noscript = !!(strict || parser.opt.noscript);
    parser.state = S.BEGIN;
    parser.strictEntities = parser.opt.strictEntities;
    parser.ENTITIES = parser.strictEntities
      ? Object.create(sax.XML_ENTITIES)
      : Object.create(sax.ENTITIES);
    parser.attribList = [];

    // namespaces form a prototype chain.
    // it always points at the current tag,
    // which protos to its parent tag.
    if (parser.opt.xmlns) {
      parser.ns = Object.create(rootNS);
    }

    // mostly just for error reporting
    parser.trackPosition = parser.opt.position !== false;
    if (parser.trackPosition) {
      parser.position = parser.line = parser.column = 0;
    }
    emit(parser, "onready");
  }

  if (!Object.create) {
    Object.create = function (o) {
      function F() {}
      F.prototype = o;
      var newf = new F();
      return newf;
    };
  }

  if (!Object.keys) {
    Object.keys = function (o) {
      var a = [];
      for (var i in o) if (o.hasOwnProperty(i)) a.push(i);
      return a;
    };
  }

  function checkBufferLength(parser) {
    var maxAllowed = Math.max(sax.MAX_BUFFER_LENGTH, 10);
    var maxActual = 0;
    for (var i = 0, l = buffers.length; i < l; i++) {
      var len = parser[buffers[i]].length;
      if (len > maxAllowed) {
        // Text/cdata nodes can get big, and since they're buffered,
        // we can get here under normal conditions.
        // Avoid issues by emitting the text node now,
        // so at least it won't get any bigger.
        switch (buffers[i]) {
          case "textNode":
            closeText(parser);
            break;

          case "cdata":
            emitNode(parser, "oncdata", parser.cdata);
            parser.cdata = "";
            break;

          case "script":
            emitNode(parser, "onscript", parser.script);
            parser.script = "";
            break;

          default:
            error(parser, "Max buffer length exceeded: " + buffers[i]);
        }
      }
      maxActual = Math.max(maxActual, len);
    }
    // schedule the next check for the earliest possible buffer overrun.
    var m = sax.MAX_BUFFER_LENGTH - maxActual;
    parser.bufferCheckPosition = m + parser.position;
  }

  function clearBuffers(parser) {
    for (var i = 0, l = buffers.length; i < l; i++) {
      parser[buffers[i]] = "";
    }
  }

  function flushBuffers(parser) {
    closeText(parser);
    if (parser.cdata !== "") {
      emitNode(parser, "oncdata", parser.cdata);
      parser.cdata = "";
    }
    if (parser.script !== "") {
      emitNode(parser, "onscript", parser.script);
      parser.script = "";
    }
  }

  SAXParser.prototype = {
    end: function () {
      end(this);
    },
    write: write,
    resume: function () {
      this.error = null;
      return this;
    },
    close: function () {
      return this.write(null);
    },
    flush: function () {
      flushBuffers(this);
    },
  };

  var Stream;
  try {
    Stream = require("stream").Stream;
  } catch (ex) {
    Stream = function () {};
  }
  if (!Stream) Stream = function () {};

  var streamWraps = sax.EVENTS.filter(function (ev) {
    return ev !== "error" && ev !== "end";
  });

  function createStream(strict, opt) {
    return new SAXStream(strict, opt);
  }

  function SAXStream(strict, opt) {
    if (!(this instanceof SAXStream)) {
      return new SAXStream(strict, opt);
    }

    Stream.apply(this);

    this._parser = new SAXParser(strict, opt);
    this.writable = true;
    this.readable = true;

    var me = this;

    this._parser.onend = function () {
      me.emit("end");
    };

    this._parser.onerror = function (er) {
      me.emit("error", er);

      // if didn't throw, then means error was handled.
      // go ahead and clear error, so we can write again.
      me._parser.error = null;
    };

    this._decoder = null;

    streamWraps.forEach(function (ev) {
      Object.defineProperty(me, "on" + ev, {
        get: function () {
          return me._parser["on" + ev];
        },
        set: function (h) {
          if (!h) {
            me.removeAllListeners(ev);
            me._parser["on" + ev] = h;
            return h;
          }
          me.on(ev, h);
        },
        enumerable: true,
        configurable: false,
      });
    });
  }

  SAXStream.prototype = Object.create(Stream.prototype, {
    constructor: {
      value: SAXStream,
    },
  });

  SAXStream.prototype.write = function (data) {
    if (
      typeof Buffer === "function" &&
      typeof Buffer.isBuffer === "function" &&
      Buffer.isBuffer(data)
    ) {
      if (!this._decoder) {
        var SD = require("string_decoder").StringDecoder;
        this._decoder = new SD("utf8");
      }
      data = this._decoder.write(data);
    }

    this._parser.write(data.toString());
    this.emit("data", data);
    return true;
  };

  SAXStream.prototype.end = function (chunk) {
    if (chunk && chunk.length) {
      this.write(chunk);
    }
    this._parser.end();
    return true;
  };

  SAXStream.prototype.on = function (ev, handler) {
    var me = this;
    if (!me._parser["on" + ev] && streamWraps.indexOf(ev) !== -1) {
      me._parser["on" + ev] = function () {
        var args =
          arguments.length === 1
            ? [arguments[0]]
            : Array.apply(null, arguments);
        args.splice(0, 0, ev);
        me.emit.apply(me, args);
      };
    }

    return Stream.prototype.on.call(me, ev, handler);
  };

  // this really needs to be replaced with character classes.
  // XML allows all manner of ridiculous numbers and digits.
  var CDATA = "[CDATA[";
  var DOCTYPE = "DOCTYPE";
  var XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
  var XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";
  var rootNS = { xml: XML_NAMESPACE, xmlns: XMLNS_NAMESPACE };

  // http://www.w3.org/TR/REC-xml/#NT-NameStartChar
  // This implementation works on strings, a single character at a time
  // as such, it cannot ever support astral-plane characters (10000-EFFFF)
  // without a significant breaking change to either this  parser, or the
  // JavaScript language.  Implementation of an emoji-capable xml parser
  // is left as an exercise for the reader.
  var nameStart =
    /[:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/;

  var nameBody =
    /[:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u00B7\u0300-\u036F\u203F-\u2040.\d-]/;

  var entityStart =
    /[#:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/;
  var entityBody =
    /[#:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u00B7\u0300-\u036F\u203F-\u2040.\d-]/;

  function isWhitespace(c) {
    return c === " " || c === "\n" || c === "\r" || c === "\t";
  }

  function isQuote(c) {
    return c === '"' || c === "'";
  }

  function isAttribEnd(c) {
    return c === ">" || isWhitespace(c);
  }

  function isMatch(regex, c) {
    return regex.test(c);
  }

  function notMatch(regex, c) {
    return !isMatch(regex, c);
  }

  var S = 0;
  sax.STATE = {
    BEGIN: S++, // leading byte order mark or whitespace
    BEGIN_WHITESPACE: S++, // leading whitespace
    TEXT: S++, // general stuff
    TEXT_ENTITY: S++, // &amp and such.
    OPEN_WAKA: S++, // <
    SGML_DECL: S++, // <!BLARG
    SGML_DECL_QUOTED: S++, // <!BLARG foo "bar
    DOCTYPE: S++, // <!DOCTYPE
    DOCTYPE_QUOTED: S++, // <!DOCTYPE "//blah
    DOCTYPE_DTD: S++, // <!DOCTYPE "//blah" [ ...
    DOCTYPE_DTD_QUOTED: S++, // <!DOCTYPE "//blah" [ "foo
    COMMENT_STARTING: S++, // <!-
    COMMENT: S++, // <!--
    COMMENT_ENDING: S++, // <!-- blah -
    COMMENT_ENDED: S++, // <!-- blah --
    CDATA: S++, // <![CDATA[ something
    CDATA_ENDING: S++, // ]
    CDATA_ENDING_2: S++, // ]]
    PROC_INST: S++, // <?hi
    PROC_INST_BODY: S++, // <?hi there
    PROC_INST_ENDING: S++, // <?hi "there" ?
    OPEN_TAG: S++, // <strong
    OPEN_TAG_SLASH: S++, // <strong /
    ATTRIB: S++, // <a
    ATTRIB_NAME: S++, // <a foo
    ATTRIB_NAME_SAW_WHITE: S++, // <a foo _
    ATTRIB_VALUE: S++, // <a foo=
    ATTRIB_VALUE_QUOTED: S++, // <a foo="bar
    ATTRIB_VALUE_CLOSED: S++, // <a foo="bar"
    ATTRIB_VALUE_UNQUOTED: S++, // <a foo=bar
    ATTRIB_VALUE_ENTITY_Q: S++, // <foo bar="&quot;"
    ATTRIB_VALUE_ENTITY_U: S++, // <foo bar=&quot
    CLOSE_TAG: S++, // </a
    CLOSE_TAG_SAW_WHITE: S++, // </a   >
    SCRIPT: S++, // <script> ...
    SCRIPT_ENDING: S++, // <script> ... <
  };

  sax.XML_ENTITIES = {
    amp: "&",
    gt: ">",
    lt: "<",
    quot: '"',
    apos: "'",
  };

  sax.ENTITIES = {
    amp: "&",
    gt: ">",
    lt: "<",
    quot: '"',
    apos: "'",
    AElig: 198,
    Aacute: 193,
    Acirc: 194,
    Agrave: 192,
    Aring: 197,
    Atilde: 195,
    Auml: 196,
    Ccedil: 199,
    ETH: 208,
    Eacute: 201,
    Ecirc: 202,
    Egrave: 200,
    Euml: 203,
    Iacute: 205,
    Icirc: 206,
    Igrave: 204,
    Iuml: 207,
    Ntilde: 209,
    Oacute: 211,
    Ocirc: 212,
    Ograve: 210,
    Oslash: 216,
    Otilde: 213,
    Ouml: 214,
    THORN: 222,
    Uacute: 218,
    Ucirc: 219,
    Ugrave: 217,
    Uuml: 220,
    Yacute: 221,
    aacute: 225,
    acirc: 226,
    aelig: 230,
    agrave: 224,
    aring: 229,
    atilde: 227,
    auml: 228,
    ccedil: 231,
    eacute: 233,
    ecirc: 234,
    egrave: 232,
    eth: 240,
    euml: 235,
    iacute: 237,
    icirc: 238,
    igrave: 236,
    iuml: 239,
    ntilde: 241,
    oacute: 243,
    ocirc: 244,
    ograve: 242,
    oslash: 248,
    otilde: 245,
    ouml: 246,
    szlig: 223,
    thorn: 254,
    uacute: 250,
    ucirc: 251,
    ugrave: 249,
    uuml: 252,
    yacute: 253,
    yuml: 255,
    copy: 169,
    reg: 174,
    nbsp: 160,
    iexcl: 161,
    cent: 162,
    pound: 163,
    curren: 164,
    yen: 165,
    brvbar: 166,
    sect: 167,
    uml: 168,
    ordf: 170,
    laquo: 171,
    not: 172,
    shy: 173,
    macr: 175,
    deg: 176,
    plusmn: 177,
    sup1: 185,
    sup2: 178,
    sup3: 179,
    acute: 180,
    micro: 181,
    para: 182,
    middot: 183,
    cedil: 184,
    ordm: 186,
    raquo: 187,
    frac14: 188,
    frac12: 189,
    frac34: 190,
    iquest: 191,
    times: 215,
    divide: 247,
    OElig: 338,
    oelig: 339,
    Scaron: 352,
    scaron: 353,
    Yuml: 376,
    fnof: 402,
    circ: 710,
    tilde: 732,
    Alpha: 913,
    Beta: 914,
    Gamma: 915,
    Delta: 916,
    Epsilon: 917,
    Zeta: 918,
    Eta: 919,
    Theta: 920,
    Iota: 921,
    Kappa: 922,
    Lambda: 923,
    Mu: 924,
    Nu: 925,
    Xi: 926,
    Omicron: 927,
    Pi: 928,
    Rho: 929,
    Sigma: 931,
    Tau: 932,
    Upsilon: 933,
    Phi: 934,
    Chi: 935,
    Psi: 936,
    Omega: 937,
    alpha: 945,
    beta: 946,
    gamma: 947,
    delta: 948,
    epsilon: 949,
    zeta: 950,
    eta: 951,
    theta: 952,
    iota: 953,
    kappa: 954,
    lambda: 955,
    mu: 956,
    nu: 957,
    xi: 958,
    omicron: 959,
    pi: 960,
    rho: 961,
    sigmaf: 962,
    sigma: 963,
    tau: 964,
    upsilon: 965,
    phi: 966,
    chi: 967,
    psi: 968,
    omega: 969,
    thetasym: 977,
    upsih: 978,
    piv: 982,
    ensp: 8194,
    emsp: 8195,
    thinsp: 8201,
    zwnj: 8204,
    zwj: 8205,
    lrm: 8206,
    rlm: 8207,
    ndash: 8211,
    mdash: 8212,
    lsquo: 8216,
    rsquo: 8217,
    sbquo: 8218,
    ldquo: 8220,
    rdquo: 8221,
    bdquo: 8222,
    dagger: 8224,
    Dagger: 8225,
    bull: 8226,
    hellip: 8230,
    permil: 8240,
    prime: 8242,
    Prime: 8243,
    lsaquo: 8249,
    rsaquo: 8250,
    oline: 8254,
    frasl: 8260,
    euro: 8364,
    image: 8465,
    weierp: 8472,
    real: 8476,
    trade: 8482,
    alefsym: 8501,
    larr: 8592,
    uarr: 8593,
    rarr: 8594,
    darr: 8595,
    harr: 8596,
    crarr: 8629,
    lArr: 8656,
    uArr: 8657,
    rArr: 8658,
    dArr: 8659,
    hArr: 8660,
    forall: 8704,
    part: 8706,
    exist: 8707,
    empty: 8709,
    nabla: 8711,
    isin: 8712,
    notin: 8713,
    ni: 8715,
    prod: 8719,
    sum: 8721,
    minus: 8722,
    lowast: 8727,
    radic: 8730,
    prop: 8733,
    infin: 8734,
    ang: 8736,
    and: 8743,
    or: 8744,
    cap: 8745,
    cup: 8746,
    int: 8747,
    there4: 8756,
    sim: 8764,
    cong: 8773,
    asymp: 8776,
    ne: 8800,
    equiv: 8801,
    le: 8804,
    ge: 8805,
    sub: 8834,
    sup: 8835,
    nsub: 8836,
    sube: 8838,
    supe: 8839,
    oplus: 8853,
    otimes: 8855,
    perp: 8869,
    sdot: 8901,
    lceil: 8968,
    rceil: 8969,
    lfloor: 8970,
    rfloor: 8971,
    lang: 9001,
    rang: 9002,
    loz: 9674,
    spades: 9824,
    clubs: 9827,
    hearts: 9829,
    diams: 9830,
  };

  Object.keys(sax.ENTITIES).forEach(function (key) {
    var e = sax.ENTITIES[key];
    var s = typeof e === "number" ? String.fromCharCode(e) : e;
    sax.ENTITIES[key] = s;
  });

  for (var s in sax.STATE) {
    sax.STATE[sax.STATE[s]] = s;
  }

  // shorthand
  S = sax.STATE;

  function emit(parser, event, data) {
    parser[event] && parser[event](data);
  }

  function emitNode(parser, nodeType, data) {
    if (parser.textNode) closeText(parser);
    emit(parser, nodeType, data);
  }

  function closeText(parser) {
    parser.textNode = textopts(parser.opt, parser.textNode);
    if (parser.textNode) emit(parser, "ontext", parser.textNode);
    parser.textNode = "";
  }

  function textopts(opt, text) {
    if (opt.trim) text = text.trim();
    if (opt.normalize) text = text.replace(/\s+/g, " ");
    return text;
  }

  function error(parser, er) {
    closeText(parser);
    if (parser.trackPosition) {
      er +=
        "\nLine: " +
        parser.line +
        "\nColumn: " +
        parser.column +
        "\nChar: " +
        parser.c;
    }
    er = new Error(er);
    parser.error = er;
    emit(parser, "onerror", er);
    return parser;
  }

  function end(parser) {
    if (parser.sawRoot && !parser.closedRoot)
      strictFail(parser, "Unclosed root tag");
    if (
      parser.state !== S.BEGIN &&
      parser.state !== S.BEGIN_WHITESPACE &&
      parser.state !== S.TEXT
    ) {
      error(parser, "Unexpected end");
    }
    closeText(parser);
    parser.c = "";
    parser.closed = true;
    emit(parser, "onend");
    SAXParser.call(parser, parser.strict, parser.opt);
    return parser;
  }

  function strictFail(parser, message) {
    if (typeof parser !== "object" || !(parser instanceof SAXParser)) {
      throw new Error("bad call to strictFail");
    }
    if (parser.strict) {
      error(parser, message);
    }
  }

  function newTag(parser) {
    if (!parser.strict) parser.tagName = parser.tagName[parser.looseCase]();
    var parent = parser.tags[parser.tags.length - 1] || parser;
    var tag = (parser.tag = { name: parser.tagName, attributes: {} });

    // will be overridden if tag contails an xmlns="foo" or xmlns:foo="bar"
    if (parser.opt.xmlns) {
      tag.ns = parent.ns;
    }
    parser.attribList.length = 0;
    emitNode(parser, "onopentagstart", tag);
  }

  function qname(name, attribute) {
    var i = name.indexOf(":");
    var qualName = i < 0 ? ["", name] : name.split(":");
    var prefix = qualName[0];
    var local = qualName[1];

    // <x "xmlns"="http://foo">
    if (attribute && name === "xmlns") {
      prefix = "xmlns";
      local = "";
    }

    return { prefix: prefix, local: local };
  }

  function attrib(parser) {
    if (!parser.strict) {
      parser.attribName = parser.attribName[parser.looseCase]();
    }

    if (
      parser.attribList.indexOf(parser.attribName) !== -1 ||
      parser.tag.attributes.hasOwnProperty(parser.attribName)
    ) {
      parser.attribName = parser.attribValue = "";
      return;
    }

    if (parser.opt.xmlns) {
      var qn = qname(parser.attribName, true);
      var prefix = qn.prefix;
      var local = qn.local;

      if (prefix === "xmlns") {
        // namespace binding attribute. push the binding into scope
        if (local === "xml" && parser.attribValue !== XML_NAMESPACE) {
          strictFail(
            parser,
            "xml: prefix must be bound to " +
              XML_NAMESPACE +
              "\n" +
              "Actual: " +
              parser.attribValue,
          );
        } else if (
          local === "xmlns" &&
          parser.attribValue !== XMLNS_NAMESPACE
        ) {
          strictFail(
            parser,
            "xmlns: prefix must be bound to " +
              XMLNS_NAMESPACE +
              "\n" +
              "Actual: " +
              parser.attribValue,
          );
        } else {
          var tag = parser.tag;
          var parent = parser.tags[parser.tags.length - 1] || parser;
          if (tag.ns === parent.ns) {
            tag.ns = Object.create(parent.ns);
          }
          tag.ns[local] = parser.attribValue;
        }
      }

      // defer onattribute events until all attributes have been seen
      // so any new bindings can take effect. preserve attribute order
      // so deferred events can be emitted in document order
      parser.attribList.push([parser.attribName, parser.attribValue]);
    } else {
      // in non-xmlns mode, we can emit the event right away
      parser.tag.attributes[parser.attribName] = parser.attribValue;
      emitNode(parser, "onattribute", {
        name: parser.attribName,
        value: parser.attribValue,
      });
    }

    parser.attribName = parser.attribValue = "";
  }

  function openTag(parser, selfClosing) {
    if (parser.opt.xmlns) {
      // emit namespace binding events
      var tag = parser.tag;

      // add namespace info to tag
      var qn = qname(parser.tagName);
      tag.prefix = qn.prefix;
      tag.local = qn.local;
      tag.uri = tag.ns[qn.prefix] || "";

      if (tag.prefix && !tag.uri) {
        strictFail(
          parser,
          "Unbound namespace prefix: " + JSON.stringify(parser.tagName),
        );
        tag.uri = qn.prefix;
      }

      var parent = parser.tags[parser.tags.length - 1] || parser;
      if (tag.ns && parent.ns !== tag.ns) {
        Object.keys(tag.ns).forEach(function (p) {
          emitNode(parser, "onopennamespace", {
            prefix: p,
            uri: tag.ns[p],
          });
        });
      }

      // handle deferred onattribute events
      // Note: do not apply default ns to attributes:
      //   http://www.w3.org/TR/REC-xml-names/#defaulting
      for (var i = 0, l = parser.attribList.length; i < l; i++) {
        var nv = parser.attribList[i];
        var name = nv[0];
        var value = nv[1];
        var qualName = qname(name, true);
        var prefix = qualName.prefix;
        var local = qualName.local;
        var uri = prefix === "" ? "" : tag.ns[prefix] || "";
        var a = {
          name: name,
          value: value,
          prefix: prefix,
          local: local,
          uri: uri,
        };

        // if there's any attributes with an undefined namespace,
        // then fail on them now.
        if (prefix && prefix !== "xmlns" && !uri) {
          strictFail(
            parser,
            "Unbound namespace prefix: " + JSON.stringify(prefix),
          );
          a.uri = prefix;
        }
        parser.tag.attributes[name] = a;
        emitNode(parser, "onattribute", a);
      }
      parser.attribList.length = 0;
    }

    parser.tag.isSelfClosing = !!selfClosing;

    // process the tag
    parser.sawRoot = true;
    parser.tags.push(parser.tag);
    emitNode(parser, "onopentag", parser.tag);
    if (!selfClosing) {
      // special case for <script> in non-strict mode.
      if (!parser.noscript && parser.tagName.toLowerCase() === "script") {
        parser.state = S.SCRIPT;
      } else {
        parser.state = S.TEXT;
      }
      parser.tag = null;
      parser.tagName = "";
    }
    parser.attribName = parser.attribValue = "";
    parser.attribList.length = 0;
  }

  function closeTag(parser) {
    if (!parser.tagName) {
      strictFail(parser, "Weird empty close tag.");
      parser.textNode += "</>";
      parser.state = S.TEXT;
      return;
    }

    if (parser.script) {
      if (parser.tagName !== "script") {
        parser.script += "</" + parser.tagName + ">";
        parser.tagName = "";
        parser.state = S.SCRIPT;
        return;
      }
      emitNode(parser, "onscript", parser.script);
      parser.script = "";
    }

    // first make sure that the closing tag actually exists.
    // <a><b></c></b></a> will close everything, otherwise.
    var t = parser.tags.length;
    var tagName = parser.tagName;
    if (!parser.strict) {
      tagName = tagName[parser.looseCase]();
    }
    var closeTo = tagName;
    while (t--) {
      var close = parser.tags[t];
      if (close.name !== closeTo) {
        // fail the first time in strict mode
        strictFail(parser, "Unexpected close tag");
      } else {
        break;
      }
    }

    // didn't find it.  we already failed for strict, so just abort.
    if (t < 0) {
      strictFail(parser, "Unmatched closing tag: " + parser.tagName);
      parser.textNode += "</" + parser.tagName + ">";
      parser.state = S.TEXT;
      return;
    }
    parser.tagName = tagName;
    var s = parser.tags.length;
    while (s-- > t) {
      var tag = (parser.tag = parser.tags.pop());
      parser.tagName = parser.tag.name;
      emitNode(parser, "onclosetag", parser.tagName);

      var x = {};
      for (var i in tag.ns) {
        x[i] = tag.ns[i];
      }

      var parent = parser.tags[parser.tags.length - 1] || parser;
      if (parser.opt.xmlns && tag.ns !== parent.ns) {
        // remove namespace bindings introduced by tag
        Object.keys(tag.ns).forEach(function (p) {
          var n = tag.ns[p];
          emitNode(parser, "onclosenamespace", { prefix: p, uri: n });
        });
      }
    }
    if (t === 0) parser.closedRoot = true;
    parser.tagName = parser.attribValue = parser.attribName = "";
    parser.attribList.length = 0;
    parser.state = S.TEXT;
  }

  function parseEntity(parser) {
    var entity = parser.entity;
    var entityLC = entity.toLowerCase();
    var num;
    var numStr = "";

    if (parser.ENTITIES[entity]) {
      return parser.ENTITIES[entity];
    }
    if (parser.ENTITIES[entityLC]) {
      return parser.ENTITIES[entityLC];
    }
    entity = entityLC;
    if (entity.charAt(0) === "#") {
      if (entity.charAt(1) === "x") {
        entity = entity.slice(2);
        num = parseInt(entity, 16);
        numStr = num.toString(16);
      } else {
        entity = entity.slice(1);
        num = parseInt(entity, 10);
        numStr = num.toString(10);
      }
    }
    entity = entity.replace(/^0+/, "");
    if (isNaN(num) || numStr.toLowerCase() !== entity) {
      strictFail(parser, "Invalid character entity");
      return "&" + parser.entity + ";";
    }

    return String.fromCodePoint(num);
  }

  function beginWhiteSpace(parser, c) {
    if (c === "<") {
      parser.state = S.OPEN_WAKA;
      parser.startTagPosition = parser.position;
    } else if (!isWhitespace(c)) {
      // have to process this as a text node.
      // weird, but happens.
      strictFail(parser, "Non-whitespace before first tag.");
      parser.textNode = c;
      parser.state = S.TEXT;
    }
  }

  function charAt(chunk, i) {
    var result = "";
    if (i < chunk.length) {
      result = chunk.charAt(i);
    }
    return result;
  }

  function write(chunk) {
    var parser = this;
    if (this.error) {
      throw this.error;
    }
    if (parser.closed) {
      return error(
        parser,
        "Cannot write after close. Assign an onready handler.",
      );
    }
    if (chunk === null) {
      return end(parser);
    }
    if (typeof chunk === "object") {
      chunk = chunk.toString();
    }
    var i = 0;
    var c = "";
    while (true) {
      c = charAt(chunk, i++);
      parser.c = c;

      if (!c) {
        break;
      }

      if (parser.trackPosition) {
        parser.position++;
        if (c === "\n") {
          parser.line++;
          parser.column = 0;
        } else {
          parser.column++;
        }
      }

      switch (parser.state) {
        case S.BEGIN:
          parser.state = S.BEGIN_WHITESPACE;
          if (c === "\uFEFF") {
            continue;
          }
          beginWhiteSpace(parser, c);
          continue;

        case S.BEGIN_WHITESPACE:
          beginWhiteSpace(parser, c);
          continue;

        case S.TEXT:
          if (parser.sawRoot && !parser.closedRoot) {
            var starti = i - 1;
            while (c && c !== "<" && c !== "&") {
              c = charAt(chunk, i++);
              if (c && parser.trackPosition) {
                parser.position++;
                if (c === "\n") {
                  parser.line++;
                  parser.column = 0;
                } else {
                  parser.column++;
                }
              }
            }
            parser.textNode += chunk.substring(starti, i - 1);
          }
          if (
            c === "<" &&
            !(parser.sawRoot && parser.closedRoot && !parser.strict)
          ) {
            parser.state = S.OPEN_WAKA;
            parser.startTagPosition = parser.position;
          } else {
            if (!isWhitespace(c) && (!parser.sawRoot || parser.closedRoot)) {
              strictFail(parser, "Text data outside of root node.");
            }
            if (c === "&") {
              parser.state = S.TEXT_ENTITY;
            } else {
              parser.textNode += c;
            }
          }
          continue;

        case S.SCRIPT:
          // only non-strict
          if (c === "<") {
            parser.state = S.SCRIPT_ENDING;
          } else {
            parser.script += c;
          }
          continue;

        case S.SCRIPT_ENDING:
          if (c === "/") {
            parser.state = S.CLOSE_TAG;
          } else {
            parser.script += "<" + c;
            parser.state = S.SCRIPT;
          }
          continue;

        case S.OPEN_WAKA:
          // either a /, ?, !, or text is coming next.
          if (c === "!") {
            parser.state = S.SGML_DECL;
            parser.sgmlDecl = "";
          } else if (isWhitespace(c)) {
            // wait for it...
          } else if (isMatch(nameStart, c)) {
            parser.state = S.OPEN_TAG;
            parser.tagName = c;
          } else if (c === "/") {
            parser.state = S.CLOSE_TAG;
            parser.tagName = "";
          } else if (c === "?") {
            parser.state = S.PROC_INST;
            parser.procInstName = parser.procInstBody = "";
          } else {
            strictFail(parser, "Unencoded <");
            // if there was some whitespace, then add that in.
            if (parser.startTagPosition + 1 < parser.position) {
              var pad = parser.position - parser.startTagPosition;
              c = new Array(pad).join(" ") + c;
            }
            parser.textNode += "<" + c;
            parser.state = S.TEXT;
          }
          continue;

        case S.SGML_DECL:
          if ((parser.sgmlDecl + c).toUpperCase() === CDATA) {
            emitNode(parser, "onopencdata");
            parser.state = S.CDATA;
            parser.sgmlDecl = "";
            parser.cdata = "";
          } else if (parser.sgmlDecl + c === "--") {
            parser.state = S.COMMENT;
            parser.comment = "";
            parser.sgmlDecl = "";
          } else if ((parser.sgmlDecl + c).toUpperCase() === DOCTYPE) {
            parser.state = S.DOCTYPE;
            if (parser.doctype || parser.sawRoot) {
              strictFail(parser, "Inappropriately located doctype declaration");
            }
            parser.doctype = "";
            parser.sgmlDecl = "";
          } else if (c === ">") {
            emitNode(parser, "onsgmldeclaration", parser.sgmlDecl);
            parser.sgmlDecl = "";
            parser.state = S.TEXT;
          } else if (isQuote(c)) {
            parser.state = S.SGML_DECL_QUOTED;
            parser.sgmlDecl += c;
          } else {
            parser.sgmlDecl += c;
          }
          continue;

        case S.SGML_DECL_QUOTED:
          if (c === parser.q) {
            parser.state = S.SGML_DECL;
            parser.q = "";
          }
          parser.sgmlDecl += c;
          continue;

        case S.DOCTYPE:
          if (c === ">") {
            parser.state = S.TEXT;
            emitNode(parser, "ondoctype", parser.doctype);
            parser.doctype = true; // just remember that we saw it.
          } else {
            parser.doctype += c;
            if (c === "[") {
              parser.state = S.DOCTYPE_DTD;
            } else if (isQuote(c)) {
              parser.state = S.DOCTYPE_QUOTED;
              parser.q = c;
            }
          }
          continue;

        case S.DOCTYPE_QUOTED:
          parser.doctype += c;
          if (c === parser.q) {
            parser.q = "";
            parser.state = S.DOCTYPE;
          }
          continue;

        case S.DOCTYPE_DTD:
          parser.doctype += c;
          if (c === "]") {
            parser.state = S.DOCTYPE;
          } else if (isQuote(c)) {
            parser.state = S.DOCTYPE_DTD_QUOTED;
            parser.q = c;
          }
          continue;

        case S.DOCTYPE_DTD_QUOTED:
          parser.doctype += c;
          if (c === parser.q) {
            parser.state = S.DOCTYPE_DTD;
            parser.q = "";
          }
          continue;

        case S.COMMENT:
          if (c === "-") {
            parser.state = S.COMMENT_ENDING;
          } else {
            parser.comment += c;
          }
          continue;

        case S.COMMENT_ENDING:
          if (c === "-") {
            parser.state = S.COMMENT_ENDED;
            parser.comment = textopts(parser.opt, parser.comment);
            if (parser.comment) {
              emitNode(parser, "oncomment", parser.comment);
            }
            parser.comment = "";
          } else {
            parser.comment += "-" + c;
            parser.state = S.COMMENT;
          }
          continue;

        case S.COMMENT_ENDED:
          if (c !== ">") {
            strictFail(parser, "Malformed comment");
            // allow <!-- blah -- bloo --> in non-strict mode,
            // which is a comment of " blah -- bloo "
            parser.comment += "--" + c;
            parser.state = S.COMMENT;
          } else {
            parser.state = S.TEXT;
          }
          continue;

        case S.CDATA:
          if (c === "]") {
            parser.state = S.CDATA_ENDING;
          } else {
            parser.cdata += c;
          }
          continue;

        case S.CDATA_ENDING:
          if (c === "]") {
            parser.state = S.CDATA_ENDING_2;
          } else {
            parser.cdata += "]" + c;
            parser.state = S.CDATA;
          }
          continue;

        case S.CDATA_ENDING_2:
          if (c === ">") {
            if (parser.cdata) {
              emitNode(parser, "oncdata", parser.cdata);
            }
            emitNode(parser, "onclosecdata");
            parser.cdata = "";
            parser.state = S.TEXT;
          } else if (c === "]") {
            parser.cdata += "]";
          } else {
            parser.cdata += "]]" + c;
            parser.state = S.CDATA;
          }
          continue;

        case S.PROC_INST:
          if (c === "?") {
            parser.state = S.PROC_INST_ENDING;
          } else if (isWhitespace(c)) {
            parser.state = S.PROC_INST_BODY;
          } else {
            parser.procInstName += c;
          }
          continue;

        case S.PROC_INST_BODY:
          if (!parser.procInstBody && isWhitespace(c)) {
            continue;
          } else if (c === "?") {
            parser.state = S.PROC_INST_ENDING;
          } else {
            parser.procInstBody += c;
          }
          continue;

        case S.PROC_INST_ENDING:
          if (c === ">") {
            emitNode(parser, "onprocessinginstruction", {
              name: parser.procInstName,
              body: parser.procInstBody,
            });
            parser.procInstName = parser.procInstBody = "";
            parser.state = S.TEXT;
          } else {
            parser.procInstBody += "?" + c;
            parser.state = S.PROC_INST_BODY;
          }
          continue;

        case S.OPEN_TAG:
          if (isMatch(nameBody, c)) {
            parser.tagName += c;
          } else {
            newTag(parser);
            if (c === ">") {
              openTag(parser);
            } else if (c === "/") {
              parser.state = S.OPEN_TAG_SLASH;
            } else {
              if (!isWhitespace(c)) {
                strictFail(parser, "Invalid character in tag name");
              }
              parser.state = S.ATTRIB;
            }
          }
          continue;

        case S.OPEN_TAG_SLASH:
          if (c === ">") {
            openTag(parser, true);
            closeTag(parser);
          } else {
            strictFail(
              parser,
              "Forward-slash in opening tag not followed by >",
            );
            parser.state = S.ATTRIB;
          }
          continue;

        case S.ATTRIB:
          // haven't read the attribute name yet.
          if (isWhitespace(c)) {
            continue;
          } else if (c === ">") {
            openTag(parser);
          } else if (c === "/") {
            parser.state = S.OPEN_TAG_SLASH;
          } else if (isMatch(nameStart, c)) {
            parser.attribName = c;
            parser.attribValue = "";
            parser.state = S.ATTRIB_NAME;
          } else {
            strictFail(parser, "Invalid attribute name");
          }
          continue;

        case S.ATTRIB_NAME:
          if (c === "=") {
            parser.state = S.ATTRIB_VALUE;
          } else if (c === ">") {
            strictFail(parser, "Attribute without value");
            parser.attribValue = parser.attribName;
            attrib(parser);
            openTag(parser);
          } else if (isWhitespace(c)) {
            parser.state = S.ATTRIB_NAME_SAW_WHITE;
          } else if (isMatch(nameBody, c)) {
            parser.attribName += c;
          } else {
            strictFail(parser, "Invalid attribute name");
          }
          continue;

        case S.ATTRIB_NAME_SAW_WHITE:
          if (c === "=") {
            parser.state = S.ATTRIB_VALUE;
          } else if (isWhitespace(c)) {
            continue;
          } else {
            strictFail(parser, "Attribute without value");
            parser.tag.attributes[parser.attribName] = "";
            parser.attribValue = "";
            emitNode(parser, "onattribute", {
              name: parser.attribName,
              value: "",
            });
            parser.attribName = "";
            if (c === ">") {
              openTag(parser);
            } else if (isMatch(nameStart, c)) {
              parser.attribName = c;
              parser.state = S.ATTRIB_NAME;
            } else {
              strictFail(parser, "Invalid attribute name");
              parser.state = S.ATTRIB;
            }
          }
          continue;

        case S.ATTRIB_VALUE:
          if (isWhitespace(c)) {
            continue;
          } else if (isQuote(c)) {
            parser.q = c;
            parser.state = S.ATTRIB_VALUE_QUOTED;
          } else {
            strictFail(parser, "Unquoted attribute value");
            parser.state = S.ATTRIB_VALUE_UNQUOTED;
            parser.attribValue = c;
          }
          continue;

        case S.ATTRIB_VALUE_QUOTED:
          if (c !== parser.q) {
            if (c === "&") {
              parser.state = S.ATTRIB_VALUE_ENTITY_Q;
            } else {
              parser.attribValue += c;
            }
            continue;
          }
          attrib(parser);
          parser.q = "";
          parser.state = S.ATTRIB_VALUE_CLOSED;
          continue;

        case S.ATTRIB_VALUE_CLOSED:
          if (isWhitespace(c)) {
            parser.state = S.ATTRIB;
          } else if (c === ">") {
            openTag(parser);
          } else if (c === "/") {
            parser.state = S.OPEN_TAG_SLASH;
          } else if (isMatch(nameStart, c)) {
            strictFail(parser, "No whitespace between attributes");
            parser.attribName = c;
            parser.attribValue = "";
            parser.state = S.ATTRIB_NAME;
          } else {
            strictFail(parser, "Invalid attribute name");
          }
          continue;

        case S.ATTRIB_VALUE_UNQUOTED:
          if (!isAttribEnd(c)) {
            if (c === "&") {
              parser.state = S.ATTRIB_VALUE_ENTITY_U;
            } else {
              parser.attribValue += c;
            }
            continue;
          }
          attrib(parser);
          if (c === ">") {
            openTag(parser);
          } else {
            parser.state = S.ATTRIB;
          }
          continue;

        case S.CLOSE_TAG:
          if (!parser.tagName) {
            if (isWhitespace(c)) {
              continue;
            } else if (notMatch(nameStart, c)) {
              if (parser.script) {
                parser.script += "</" + c;
                parser.state = S.SCRIPT;
              } else {
                strictFail(parser, "Invalid tagname in closing tag.");
              }
            } else {
              parser.tagName = c;
            }
          } else if (c === ">") {
            closeTag(parser);
          } else if (isMatch(nameBody, c)) {
            parser.tagName += c;
          } else if (parser.script) {
            parser.script += "</" + parser.tagName;
            parser.tagName = "";
            parser.state = S.SCRIPT;
          } else {
            if (!isWhitespace(c)) {
              strictFail(parser, "Invalid tagname in closing tag");
            }
            parser.state = S.CLOSE_TAG_SAW_WHITE;
          }
          continue;

        case S.CLOSE_TAG_SAW_WHITE:
          if (isWhitespace(c)) {
            continue;
          }
          if (c === ">") {
            closeTag(parser);
          } else {
            strictFail(parser, "Invalid characters in closing tag");
          }
          continue;

        case S.TEXT_ENTITY:
        case S.ATTRIB_VALUE_ENTITY_Q:
        case S.ATTRIB_VALUE_ENTITY_U:
          var returnState;
          var buffer;
          switch (parser.state) {
            case S.TEXT_ENTITY:
              returnState = S.TEXT;
              buffer = "textNode";
              break;

            case S.ATTRIB_VALUE_ENTITY_Q:
              returnState = S.ATTRIB_VALUE_QUOTED;
              buffer = "attribValue";
              break;

            case S.ATTRIB_VALUE_ENTITY_U:
              returnState = S.ATTRIB_VALUE_UNQUOTED;
              buffer = "attribValue";
              break;
          }

          if (c === ";") {
            if (parser.opt.unparsedEntities) {
              var parsedEntity = parseEntity(parser);
              parser.entity = "";
              parser.state = returnState;
              parser.write(parsedEntity);
            } else {
              parser[buffer] += parseEntity(parser);
              parser.entity = "";
              parser.state = returnState;
            }
          } else if (
            isMatch(parser.entity.length ? entityBody : entityStart, c)
          ) {
            parser.entity += c;
          } else {
            strictFail(parser, "Invalid character in entity name");
            parser[buffer] += "&" + parser.entity + c;
            parser.entity = "";
            parser.state = returnState;
          }

          continue;

        default: /* istanbul ignore next */ {
          throw new Error(parser, "Unknown state: " + parser.state);
        }
      }
    } // while

    if (parser.position >= parser.bufferCheckPosition) {
      checkBufferLength(parser);
    }
    return parser;
  }

  /*! http://mths.be/fromcodepoint v0.1.0 by @mathias */
  /* istanbul ignore next */
  if (!String.fromCodePoint) {
    (function () {
      var stringFromCharCode = String.fromCharCode;
      var floor = Math.floor;
      var fromCodePoint = function () {
        var MAX_SIZE = 0x4000;
        var codeUnits = [];
        var highSurrogate;
        var lowSurrogate;
        var index = -1;
        var length = arguments.length;
        if (!length) {
          return "";
        }
        var result = "";
        while (++index < length) {
          var codePoint = Number(arguments[index]);
          if (
            !isFinite(codePoint) || // `NaN`, `+Infinity`, or `-Infinity`
            codePoint < 0 || // not a valid Unicode code point
            codePoint > 0x10ffff || // not a valid Unicode code point
            floor(codePoint) !== codePoint // not an integer
          ) {
            throw RangeError("Invalid code point: " + codePoint);
          }
          if (codePoint <= 0xffff) {
            // BMP code point
            codeUnits.push(codePoint);
          } else {
            // Astral code point; split in surrogate halves
            // http://mathiasbynens.be/notes/javascript-encoding#surrogate-formulae
            codePoint -= 0x10000;
            highSurrogate = (codePoint >> 10) + 0xd800;
            lowSurrogate = (codePoint % 0x400) + 0xdc00;
            codeUnits.push(highSurrogate, lowSurrogate);
          }
          if (index + 1 === length || codeUnits.length > MAX_SIZE) {
            result += stringFromCharCode.apply(null, codeUnits);
            codeUnits.length = 0;
          }
        }
        return result;
      };
      /* istanbul ignore next */
      if (Object.defineProperty) {
        Object.defineProperty(String, "fromCodePoint", {
          value: fromCodePoint,
          configurable: true,
          writable: true,
        });
      } else {
        String.fromCodePoint = fromCodePoint;
      }
    })();
  }
})(typeof exports === "undefined" ? (this.sax = {}) : exports);

/*

 Copyright 2000, Silicon Graphics, Inc. All Rights Reserved.
 Copyright 2015, Google Inc. All Rights Reserved.

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to
 deal in the Software without restriction, including without limitation the
 rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 sell copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

 The above copyright notice including the dates of first publication and
 either this permission notice or a reference to http://oss.sgi.com/projects/FreeB/
 shall be included in all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 SILICON GRAPHICS, INC. BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
 WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
 IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

 Original Code. The Original Code is: OpenGL Sample Implementation,
 Version 1.2.1, released January 26, 2000, developed by Silicon Graphics,
 Inc. The Original Code is Copyright (c) 1991-2000 Silicon Graphics, Inc.
 Copyright in any portions created by third parties is as indicated
 elsewhere herein. All Rights Reserved.
*/
("use strict");
var n;
function t(a, b) {
  return a.b === b.b && a.a === b.a;
}
function u(a, b) {
  return a.b < b.b || (a.b === b.b && a.a <= b.a);
}
function v(a, b, c) {
  var d = b.b - a.b,
    e = c.b - b.b;
  return 0 < d + e
    ? d < e
      ? b.a - a.a + (d / (d + e)) * (a.a - c.a)
      : b.a - c.a + (e / (d + e)) * (c.a - a.a)
    : 0;
}
function x(a, b, c) {
  var d = b.b - a.b,
    e = c.b - b.b;
  return 0 < d + e ? (b.a - c.a) * d + (b.a - a.a) * e : 0;
}
function z(a, b) {
  return a.a < b.a || (a.a === b.a && a.b <= b.b);
}
function aa(a, b, c) {
  var d = b.a - a.a,
    e = c.a - b.a;
  return 0 < d + e
    ? d < e
      ? b.b - a.b + (d / (d + e)) * (a.b - c.b)
      : b.b - c.b + (e / (d + e)) * (c.b - a.b)
    : 0;
}
function ba(a, b, c) {
  var d = b.a - a.a,
    e = c.a - b.a;
  return 0 < d + e ? (b.b - c.b) * d + (b.b - a.b) * e : 0;
}
function ca(a) {
  return u(a.b.a, a.a);
}
function da(a) {
  return u(a.a, a.b.a);
}
function A(a, b, c, d) {
  a = 0 > a ? 0 : a;
  c = 0 > c ? 0 : c;
  return a <= c
    ? 0 === c
      ? (b + d) / 2
      : b + (a / (a + c)) * (d - b)
    : d + (c / (a + c)) * (b - d);
}
function ea(a) {
  var b = B(a.b);
  C(b, a.c);
  C(b.b, a.c);
  D(b, a.a);
  return b;
}
function E(a, b) {
  var c = !1,
    d = !1;
  a !== b &&
    (b.a !== a.a && ((d = !0), F(b.a, a.a)),
    b.d !== a.d && ((c = !0), G(b.d, a.d)),
    H(b, a),
    d || (C(b, a.a), (a.a.c = a)),
    c || (D(b, a.d), (a.d.a = a)));
}
function I(a) {
  var b = a.b,
    c = !1;
  a.d !== a.b.d && ((c = !0), G(a.d, a.b.d));
  a.c === a
    ? F(a.a, null)
    : ((a.b.d.a = J(a)), (a.a.c = a.c), H(a, J(a)), c || D(a, a.d));
  b.c === b
    ? (F(b.a, null), G(b.d, null))
    : ((a.d.a = J(b)), (b.a.c = b.c), H(b, J(b)));
  fa(a);
}
function K(a) {
  var b = B(a),
    c = b.b;
  H(b, a.e);
  b.a = a.b.a;
  C(c, b.a);
  b.d = c.d = a.d;
  b = b.b;
  H(a.b, J(a.b));
  H(a.b, b);
  a.b.a = b.a;
  b.b.a.c = b.b;
  b.b.d = a.b.d;
  b.f = a.f;
  b.b.f = a.b.f;
  return b;
}
function L(a, b) {
  var c = !1,
    d = B(a),
    e = d.b;
  b.d !== a.d && ((c = !0), G(b.d, a.d));
  H(d, a.e);
  H(e, b);
  d.a = a.b.a;
  e.a = b.a;
  d.d = e.d = a.d;
  a.d.a = e;
  c || D(d, a.d);
  return d;
}
function B(a) {
  var b = new M(),
    c = new M(),
    d = a.b.h;
  c.h = d;
  d.b.h = b;
  b.h = a;
  a.b.h = c;
  b.b = c;
  b.c = b;
  b.e = c;
  c.b = b;
  c.c = c;
  return (c.e = b);
}
function H(a, b) {
  var c = a.c,
    d = b.c;
  c.b.e = b;
  d.b.e = a;
  a.c = d;
  b.c = c;
}
function C(a, b) {
  var c = b.f,
    d = new N(b, c);
  c.e = d;
  b.f = d;
  c = d.c = a;
  do (c.a = d), (c = c.c);
  while (c !== a);
}
function D(a, b) {
  var c = b.d,
    d = new ga(b, c);
  c.b = d;
  b.d = d;
  d.a = a;
  d.c = b.c;
  c = a;
  do (c.d = d), (c = c.e);
  while (c !== a);
}
function fa(a) {
  var b = a.h;
  a = a.b.h;
  b.b.h = a;
  a.b.h = b;
}
function F(a, b) {
  var c = a.c,
    d = c;
  do (d.a = b), (d = d.c);
  while (d !== c);
  c = a.f;
  d = a.e;
  d.f = c;
  c.e = d;
}
function G(a, b) {
  var c = a.a,
    d = c;
  do (d.d = b), (d = d.e);
  while (d !== c);
  c = a.d;
  d = a.b;
  d.d = c;
  c.b = d;
}
function ha(a) {
  var b = 0;
  Math.abs(a[1]) > Math.abs(a[0]) && (b = 1);
  Math.abs(a[2]) > Math.abs(a[b]) && (b = 2);
  return b;
}
var O = 4 * 1e150;
function P(a, b) {
  a.f += b.f;
  a.b.f += b.b.f;
}
function ia(a, b, c) {
  a = a.a;
  b = b.a;
  c = c.a;
  if (b.b.a === a)
    return c.b.a === a
      ? u(b.a, c.a)
        ? 0 >= x(c.b.a, b.a, c.a)
        : 0 <= x(b.b.a, c.a, b.a)
      : 0 >= x(c.b.a, a, c.a);
  if (c.b.a === a) return 0 <= x(b.b.a, a, b.a);
  b = v(b.b.a, a, b.a);
  a = v(c.b.a, a, c.a);
  return b >= a;
}
function Q(a) {
  a.a.i = null;
  var b = a.e;
  b.a.c = b.c;
  b.c.a = b.a;
  a.e = null;
}
function ja(a, b) {
  I(a.a);
  a.c = !1;
  a.a = b;
  b.i = a;
}
function ka(a) {
  var b = a.a.a;
  do a = R(a);
  while (a.a.a === b);
  a.c && ((b = L(S(a).a.b, a.a.e)), ja(a, b), (a = R(a)));
  return a;
}
function la(a, b, c) {
  var d = new ma();
  d.a = c;
  d.e = na(a.f, b.e, d);
  return (c.i = d);
}
function oa(a, b) {
  switch (a.s) {
    case 100130:
      return 0 !== (b & 1);
    case 100131:
      return 0 !== b;
    case 100132:
      return 0 < b;
    case 100133:
      return 0 > b;
    case 100134:
      return 2 <= b || -2 >= b;
  }
  return !1;
}
function pa(a) {
  var b = a.a,
    c = b.d;
  c.c = a.d;
  c.a = b;
  Q(a);
}
function T(a, b, c) {
  a = b;
  for (b = b.a; a !== c; ) {
    a.c = !1;
    var d = S(a),
      e = d.a;
    if (e.a !== b.a) {
      if (!d.c) {
        pa(a);
        break;
      }
      e = L(b.c.b, e.b);
      ja(d, e);
    }
    b.c !== e && (E(J(e), e), E(b, e));
    pa(a);
    b = d.a;
    a = d;
  }
  return b;
}
function U(a, b, c, d, e, f) {
  var g = !0;
  do la(a, b, c.b), (c = c.c);
  while (c !== d);
  for (null === e && (e = S(b).a.b.c); ; ) {
    d = S(b);
    c = d.a.b;
    if (c.a !== e.a) break;
    c.c !== e && (E(J(c), c), E(J(e), c));
    d.f = b.f - c.f;
    d.d = oa(a, d.f);
    b.b = !0;
    !g && qa(a, b) && (P(c, e), Q(b), I(e));
    g = !1;
    b = d;
    e = c;
  }
  b.b = !0;
  f && ra(a, b);
}
function sa(a, b, c, d, e) {
  var f = [b.g[0], b.g[1], b.g[2]];
  b.d = null;
  b.d = a.o ? a.o(f, c, d, a.c) || null : null;
  null === b.d && (e ? a.n || (V(a, 100156), (a.n = !0)) : (b.d = c[0]));
}
function ta(a, b, c) {
  var d = [null, null, null, null];
  d[0] = b.a.d;
  d[1] = c.a.d;
  sa(a, b.a, d, [0.5, 0.5, 0, 0], !1);
  E(b, c);
}
function ua(a, b, c, d, e) {
  var f = Math.abs(b.b - a.b) + Math.abs(b.a - a.a),
    g = Math.abs(c.b - a.b) + Math.abs(c.a - a.a),
    h = e + 1;
  d[e] = (0.5 * g) / (f + g);
  d[h] = (0.5 * f) / (f + g);
  a.g[0] += d[e] * b.g[0] + d[h] * c.g[0];
  a.g[1] += d[e] * b.g[1] + d[h] * c.g[1];
  a.g[2] += d[e] * b.g[2] + d[h] * c.g[2];
}
function qa(a, b) {
  var c = S(b),
    d = b.a,
    e = c.a;
  if (u(d.a, e.a)) {
    if (0 < x(e.b.a, d.a, e.a)) return !1;
    if (!t(d.a, e.a)) K(e.b), E(d, J(e)), (b.b = c.b = !0);
    else if (d.a !== e.a) {
      var c = a.e,
        f = d.a.h;
      if (0 <= f) {
        var c = c.b,
          g = c.d,
          h = c.e,
          k = c.c,
          l = k[f];
        g[l] = g[c.a];
        k[g[l]] = l;
        l <= --c.a &&
          (1 >= l ? W(c, l) : u(h[g[l >> 1]], h[g[l]]) ? W(c, l) : va(c, l));
        h[f] = null;
        k[f] = c.b;
        c.b = f;
      } else
        for (c.c[-(f + 1)] = null; 0 < c.a && null === c.c[c.d[c.a - 1]]; )
          --c.a;
      ta(a, J(e), d);
    }
  } else {
    if (0 > x(d.b.a, e.a, d.a)) return !1;
    R(b).b = b.b = !0;
    K(d.b);
    E(J(e), d);
  }
  return !0;
}
function wa(a, b) {
  var c = S(b),
    d = b.a,
    e = c.a,
    f = d.a,
    g = e.a,
    h = d.b.a,
    k = e.b.a,
    l = new N();
  x(h, a.a, f);
  x(k, a.a, g);
  if (f === g || Math.min(f.a, h.a) > Math.max(g.a, k.a)) return !1;
  if (u(f, g)) {
    if (0 < x(k, f, g)) return !1;
  } else if (0 > x(h, g, f)) return !1;
  var r = h,
    p = f,
    q = k,
    y = g,
    m,
    w;
  u(r, p) || ((m = r), (r = p), (p = m));
  u(q, y) || ((m = q), (q = y), (y = m));
  u(r, q) || ((m = r), (r = q), (q = m), (m = p), (p = y), (y = m));
  u(q, p)
    ? u(p, y)
      ? ((m = v(r, q, p)),
        (w = v(q, p, y)),
        0 > m + w && ((m = -m), (w = -w)),
        (l.b = A(m, q.b, w, p.b)))
      : ((m = x(r, q, p)),
        (w = -x(r, y, p)),
        0 > m + w && ((m = -m), (w = -w)),
        (l.b = A(m, q.b, w, y.b)))
    : (l.b = (q.b + p.b) / 2);
  z(r, p) || ((m = r), (r = p), (p = m));
  z(q, y) || ((m = q), (q = y), (y = m));
  z(r, q) || ((m = r), (r = q), (q = m), (m = p), (p = y), (y = m));
  z(q, p)
    ? z(p, y)
      ? ((m = aa(r, q, p)),
        (w = aa(q, p, y)),
        0 > m + w && ((m = -m), (w = -w)),
        (l.a = A(m, q.a, w, p.a)))
      : ((m = ba(r, q, p)),
        (w = -ba(r, y, p)),
        0 > m + w && ((m = -m), (w = -w)),
        (l.a = A(m, q.a, w, y.a)))
    : (l.a = (q.a + p.a) / 2);
  u(l, a.a) && ((l.b = a.a.b), (l.a = a.a.a));
  r = u(f, g) ? f : g;
  u(r, l) && ((l.b = r.b), (l.a = r.a));
  if (t(l, f) || t(l, g)) return qa(a, b), !1;
  if ((!t(h, a.a) && 0 <= x(h, a.a, l)) || (!t(k, a.a) && 0 >= x(k, a.a, l))) {
    if (k === a.a)
      return (
        K(d.b),
        E(e.b, d),
        (b = ka(b)),
        (d = S(b).a),
        T(a, S(b), c),
        U(a, b, J(d), d, d, !0),
        !0
      );
    if (h === a.a) {
      K(e.b);
      E(d.e, J(e));
      f = c = b;
      g = f.a.b.a;
      do f = R(f);
      while (f.a.b.a === g);
      b = f;
      f = S(b).a.b.c;
      c.a = J(e);
      e = T(a, c, null);
      U(a, b, e.c, d.b.c, f, !0);
      return !0;
    }
    0 <= x(h, a.a, l) &&
      ((R(b).b = b.b = !0), K(d.b), (d.a.b = a.a.b), (d.a.a = a.a.a));
    0 >= x(k, a.a, l) &&
      ((b.b = c.b = !0), K(e.b), (e.a.b = a.a.b), (e.a.a = a.a.a));
    return !1;
  }
  K(d.b);
  K(e.b);
  E(J(e), d);
  d.a.b = l.b;
  d.a.a = l.a;
  d.a.h = xa(a.e, d.a);
  d = d.a;
  e = [0, 0, 0, 0];
  l = [f.d, h.d, g.d, k.d];
  d.g[0] = d.g[1] = d.g[2] = 0;
  ua(d, f, h, e, 0);
  ua(d, g, k, e, 2);
  sa(a, d, l, e, !0);
  R(b).b = b.b = c.b = !0;
  return !1;
}
function ra(a, b) {
  for (var c = S(b); ; ) {
    for (; c.b; ) (b = c), (c = S(c));
    if (!b.b && ((c = b), (b = R(b)), null === b || !b.b)) break;
    b.b = !1;
    var d = b.a,
      e = c.a,
      f;
    if ((f = d.b.a !== e.b.a))
      a: {
        f = b;
        var g = S(f),
          h = f.a,
          k = g.a,
          l = void 0;
        if (u(h.b.a, k.b.a)) {
          if (0 > x(h.b.a, k.b.a, h.a)) {
            f = !1;
            break a;
          }
          R(f).b = f.b = !0;
          l = K(h);
          E(k.b, l);
          l.d.c = f.d;
        } else {
          if (0 < x(k.b.a, h.b.a, k.a)) {
            f = !1;
            break a;
          }
          f.b = g.b = !0;
          l = K(k);
          E(h.e, k.b);
          l.b.d.c = f.d;
        }
        f = !0;
      }
    f &&
      (c.c
        ? (Q(c), I(e), (c = S(b)), (e = c.a))
        : b.c && (Q(b), I(d), (b = R(c)), (d = b.a)));
    if (d.a !== e.a)
      if (d.b.a === e.b.a || b.c || c.c || (d.b.a !== a.a && e.b.a !== a.a))
        qa(a, b);
      else if (wa(a, b)) break;
    d.a === e.a && d.b.a === e.b.a && (P(e, d), Q(b), I(d), (b = R(c)));
  }
}
function ya(a, b) {
  a.a = b;
  for (var c = b.c; null === c.i; )
    if (((c = c.c), c === b.c)) {
      var c = a,
        d = b,
        e = new ma();
      e.a = d.c.b;
      var f = c.f,
        g = f.a;
      do g = g.a;
      while (null !== g.b && !f.c(f.b, e, g.b));
      var f = g.b,
        h = S(f),
        e = f.a,
        g = h.a;
      if (0 === x(e.b.a, d, e.a))
        (e = f.a),
          t(e.a, d) ||
            t(e.b.a, d) ||
            (K(e.b), f.c && (I(e.c), (f.c = !1)), E(d.c, e), ya(c, d));
      else {
        var k = u(g.b.a, e.b.a) ? f : h,
          h = void 0;
        f.d || k.c
          ? (k === f ? (h = L(d.c.b, e.e)) : (h = L(g.b.c.b, d.c).b),
            k.c
              ? ja(k, h)
              : ((e = c),
                (f = la(c, f, h)),
                (f.f = R(f).f + f.a.f),
                (f.d = oa(e, f.f))),
            ya(c, d))
          : U(c, f, d.c, d.c, null, !0);
      }
      return;
    }
  c = ka(c.i);
  e = S(c);
  f = e.a;
  e = T(a, e, null);
  if (e.c === f) {
    var f = e,
      e = f.c,
      g = S(c),
      h = c.a,
      k = g.a,
      l = !1;
    h.b.a !== k.b.a && wa(a, c);
    t(h.a, a.a) &&
      (E(J(e), h), (c = ka(c)), (e = S(c).a), T(a, S(c), g), (l = !0));
    t(k.a, a.a) && (E(f, J(k)), (f = T(a, g, null)), (l = !0));
    l
      ? U(a, c, f.c, e, e, !0)
      : (u(k.a, h.a) ? (d = J(k)) : (d = h),
        (d = L(f.c.b, d)),
        U(a, c, d, d.c, d.c, !1),
        (d.b.i.c = !0),
        ra(a, c));
  } else U(a, c, e.c, f, f, !0);
}
function za(a, b) {
  var c = new ma(),
    d = ea(a.b);
  d.a.b = O;
  d.a.a = b;
  d.b.a.b = -O;
  d.b.a.a = b;
  a.a = d.b.a;
  c.a = d;
  c.f = 0;
  c.d = !1;
  c.c = !1;
  c.h = !0;
  c.b = !1;
  d = a.f;
  d = na(d, d.a, c);
  c.e = d;
}
function Aa(a) {
  this.a = new Ba();
  this.b = a;
  this.c = ia;
}
function na(a, b, c) {
  do b = b.c;
  while (null !== b.b && !a.c(a.b, b.b, c));
  a = new Ba(c, b.a, b);
  b.a.c = a;
  return (b.a = a);
}
function Ba(a, b, c) {
  this.b = a || null;
  this.a = b || this;
  this.c = c || this;
}
function X() {
  this.d = Y;
  this.p = this.b = this.q = null;
  this.j = [0, 0, 0];
  this.s = 100130;
  this.n = !1;
  this.o = this.a = this.e = this.f = null;
  this.m = !1;
  this.c = this.r = this.i = this.k = this.l = this.h = null;
}
var Y = 0;
n = X.prototype;
n.x = function () {
  Z(this, Y);
};
n.B = function (a, b) {
  switch (a) {
    case 100142:
      return;
    case 100140:
      switch (b) {
        case 100130:
        case 100131:
        case 100132:
        case 100133:
        case 100134:
          this.s = b;
          return;
      }
      break;
    case 100141:
      this.m = !!b;
      return;
    default:
      V(this, 100900);
      return;
  }
  V(this, 100901);
};
n.y = function (a) {
  switch (a) {
    case 100142:
      return 0;
    case 100140:
      return this.s;
    case 100141:
      return this.m;
    default:
      V(this, 100900);
  }
  return !1;
};
n.A = function (a, b, c) {
  this.j[0] = a;
  this.j[1] = b;
  this.j[2] = c;
};
n.z = function (a, b) {
  var c = b ? b : null;
  switch (a) {
    case 100100:
    case 100106:
      this.h = c;
      break;
    case 100104:
    case 100110:
      this.l = c;
      break;
    case 100101:
    case 100107:
      this.k = c;
      break;
    case 100102:
    case 100108:
      this.i = c;
      break;
    case 100103:
    case 100109:
      this.p = c;
      break;
    case 100105:
    case 100111:
      this.o = c;
      break;
    case 100112:
      this.r = c;
      break;
    default:
      V(this, 100900);
  }
};
n.C = function (a, b) {
  var c = !1,
    d = [0, 0, 0];
  Z(this, 2);
  for (var e = 0; 3 > e; ++e) {
    var f = a[e];
    -1e150 > f && ((f = -1e150), (c = !0));
    1e150 < f && ((f = 1e150), (c = !0));
    d[e] = f;
  }
  c && V(this, 100155);
  c = this.q;
  null === c ? ((c = ea(this.b)), E(c, c.b)) : (K(c), (c = c.e));
  c.a.d = b;
  c.a.g[0] = d[0];
  c.a.g[1] = d[1];
  c.a.g[2] = d[2];
  c.f = 1;
  c.b.f = -1;
  this.q = c;
};
n.u = function (a) {
  Z(this, Y);
  this.d = 1;
  this.b = new Ca();
  this.c = a;
};
n.t = function () {
  Z(this, 1);
  this.d = 2;
  this.q = null;
};
n.v = function () {
  Z(this, 2);
  this.d = 1;
};
n.w = function () {
  Z(this, 1);
  this.d = Y;
  var a = this.j[0],
    b = this.j[1],
    c = this.j[2],
    d = !1,
    e = [a, b, c];
  if (0 === a && 0 === b && 0 === c) {
    for (
      var b = [-2 * 1e150, -2 * 1e150, -2 * 1e150],
        f = [2 * 1e150, 2 * 1e150, 2 * 1e150],
        c = [],
        g = [],
        d = this.b.c,
        a = d.e;
      a !== d;
      a = a.e
    )
      for (var h = 0; 3 > h; ++h) {
        var k = a.g[h];
        k < f[h] && ((f[h] = k), (g[h] = a));
        k > b[h] && ((b[h] = k), (c[h] = a));
      }
    a = 0;
    b[1] - f[1] > b[0] - f[0] && (a = 1);
    b[2] - f[2] > b[a] - f[a] && (a = 2);
    if (f[a] >= b[a]) (e[0] = 0), (e[1] = 0), (e[2] = 1);
    else {
      b = 0;
      f = g[a];
      c = c[a];
      g = [0, 0, 0];
      f = [f.g[0] - c.g[0], f.g[1] - c.g[1], f.g[2] - c.g[2]];
      h = [0, 0, 0];
      for (a = d.e; a !== d; a = a.e)
        (h[0] = a.g[0] - c.g[0]),
          (h[1] = a.g[1] - c.g[1]),
          (h[2] = a.g[2] - c.g[2]),
          (g[0] = f[1] * h[2] - f[2] * h[1]),
          (g[1] = f[2] * h[0] - f[0] * h[2]),
          (g[2] = f[0] * h[1] - f[1] * h[0]),
          (k = g[0] * g[0] + g[1] * g[1] + g[2] * g[2]),
          k > b && ((b = k), (e[0] = g[0]), (e[1] = g[1]), (e[2] = g[2]));
      0 >= b && ((e[0] = e[1] = e[2] = 0), (e[ha(f)] = 1));
    }
    d = !0;
  }
  g = ha(e);
  a = this.b.c;
  b = (g + 1) % 3;
  c = (g + 2) % 3;
  g = 0 < e[g] ? 1 : -1;
  for (e = a.e; e !== a; e = e.e) (e.b = e.g[b]), (e.a = g * e.g[c]);
  if (d) {
    e = 0;
    d = this.b.a;
    for (a = d.b; a !== d; a = a.b)
      if (((b = a.a), !(0 >= b.f))) {
        do (e += (b.a.b - b.b.a.b) * (b.a.a + b.b.a.a)), (b = b.e);
        while (b !== a.a);
      }
    if (0 > e) for (e = this.b.c, d = e.e; d !== e; d = d.e) d.a = -d.a;
  }
  this.n = !1;
  e = this.b.b;
  for (a = e.h; a !== e; a = d)
    if (
      ((d = a.h),
      (b = a.e),
      t(a.a, a.b.a) &&
        a.e.e !== a &&
        (ta(this, b, a), I(a), (a = b), (b = a.e)),
      b.e === a)
    ) {
      if (b !== a) {
        if (b === d || b === d.b) d = d.h;
        I(b);
      }
      if (a === d || a === d.b) d = d.h;
      I(a);
    }
  this.e = e = new Da();
  d = this.b.c;
  for (a = d.e; a !== d; a = a.e) a.h = xa(e, a);
  Ea(e);
  this.f = new Aa(this);
  za(this, -O);
  for (za(this, O); null !== (e = Fa(this.e)); ) {
    for (;;) {
      a: if (((a = this.e), 0 === a.a)) d = Ga(a.b);
      else if (
        ((d = a.c[a.d[a.a - 1]]), 0 !== a.b.a && ((a = Ga(a.b)), u(a, d)))
      ) {
        d = a;
        break a;
      }
      if (null === d || !t(d, e)) break;
      d = Fa(this.e);
      ta(this, e.c, d.c);
    }
    ya(this, e);
  }
  this.a = this.f.a.a.b.a.a;
  for (e = 0; null !== (d = this.f.a.a.b); ) d.h || ++e, Q(d);
  this.f = null;
  e = this.e;
  e.b = null;
  e.d = null;
  this.e = e.c = null;
  e = this.b;
  for (a = e.a.b; a !== e.a; a = d)
    (d = a.b), (a = a.a), a.e.e === a && (P(a.c, a), I(a));
  if (!this.n) {
    e = this.b;
    if (this.m)
      for (a = e.b.h; a !== e.b; a = d)
        (d = a.h), a.b.d.c !== a.d.c ? (a.f = a.d.c ? 1 : -1) : I(a);
    else
      for (a = e.a.b; a !== e.a; a = d)
        if (((d = a.b), a.c)) {
          for (a = a.a; u(a.b.a, a.a); a = a.c.b);
          for (; u(a.a, a.b.a); a = a.e);
          b = a.c.b;
          for (c = void 0; a.e !== b; )
            if (u(a.b.a, b.a)) {
              for (; b.e !== a && (ca(b.e) || 0 >= x(b.a, b.b.a, b.e.b.a)); )
                (c = L(b.e, b)), (b = c.b);
              b = b.c.b;
            } else {
              for (; b.e !== a && (da(a.c.b) || 0 <= x(a.b.a, a.a, a.c.b.a)); )
                (c = L(a, a.c.b)), (a = c.b);
              a = a.e;
            }
          for (; b.e.e !== a; ) (c = L(b.e, b)), (b = c.b);
        }
    if (this.h || this.i || this.k || this.l)
      if (this.m)
        for (e = this.b, d = e.a.b; d !== e.a; d = d.b) {
          if (d.c) {
            this.h && this.h(2, this.c);
            a = d.a;
            do this.k && this.k(a.a.d, this.c), (a = a.e);
            while (a !== d.a);
            this.i && this.i(this.c);
          }
        }
      else {
        e = this.b;
        d = !!this.l;
        a = !1;
        b = -1;
        for (c = e.a.d; c !== e.a; c = c.d)
          if (c.c) {
            a || (this.h && this.h(4, this.c), (a = !0));
            g = c.a;
            do
              d &&
                ((f = g.b.d.c ? 0 : 1),
                b !== f && ((b = f), this.l && this.l(!!b, this.c))),
                this.k && this.k(g.a.d, this.c),
                (g = g.e);
            while (g !== c.a);
          }
        a && this.i && this.i(this.c);
      }
    if (this.r) {
      e = this.b;
      for (a = e.a.b; a !== e.a; a = d)
        if (((d = a.b), !a.c)) {
          b = a.a;
          c = b.e;
          g = void 0;
          do
            (g = c),
              (c = g.e),
              (g.d = null),
              null === g.b.d &&
                (g.c === g ? F(g.a, null) : ((g.a.c = g.c), H(g, J(g))),
                (f = g.b),
                f.c === f ? F(f.a, null) : ((f.a.c = f.c), H(f, J(f))),
                fa(g));
          while (g !== b);
          b = a.d;
          a = a.b;
          a.d = b;
          b.b = a;
        }
      this.r(this.b);
      this.c = this.b = null;
      return;
    }
  }
  this.b = this.c = null;
};
function Z(a, b) {
  if (a.d !== b)
    for (; a.d !== b; )
      if (a.d < b)
        switch (a.d) {
          case Y:
            V(a, 100151);
            a.u(null);
            break;
          case 1:
            V(a, 100152), a.t();
        }
      else
        switch (a.d) {
          case 2:
            V(a, 100154);
            a.v();
            break;
          case 1:
            V(a, 100153), a.w();
        }
}
function V(a, b) {
  a.p && a.p(b, a.c);
}
function ga(a, b) {
  this.b = a || this;
  this.d = b || this;
  this.a = null;
  this.c = !1;
}
function M() {
  this.h = this;
  this.i = this.d = this.a = this.e = this.c = this.b = null;
  this.f = 0;
}
function J(a) {
  return a.b.e;
}
function Ca() {
  this.c = new N();
  this.a = new ga();
  this.b = new M();
  this.d = new M();
  this.b.b = this.d;
  this.d.b = this.b;
}
function N(a, b) {
  this.e = a || this;
  this.f = b || this;
  this.d = this.c = null;
  this.g = [0, 0, 0];
  this.h = this.a = this.b = 0;
}
function Da() {
  this.c = [];
  this.d = null;
  this.a = 0;
  this.e = !1;
  this.b = new Ha();
}
function Ea(a) {
  a.d = [];
  for (var b = 0; b < a.a; b++) a.d[b] = b;
  a.d.sort(
    (function (a) {
      return function (b, e) {
        return u(a[b], a[e]) ? 1 : -1;
      };
    })(a.c),
  );
  a.e = !0;
  Ia(a.b);
}
function xa(a, b) {
  if (a.e) {
    var c = a.b,
      d = ++c.a;
    2 * d > c.f && ((c.f *= 2), (c.c = Ja(c.c, c.f + 1)));
    var e;
    0 === c.b ? (e = d) : ((e = c.b), (c.b = c.c[c.b]));
    c.e[e] = b;
    c.c[e] = d;
    c.d[d] = e;
    c.h && va(c, d);
    return e;
  }
  c = a.a++;
  a.c[c] = b;
  return -(c + 1);
}
function Fa(a) {
  if (0 === a.a) return Ka(a.b);
  var b = a.c[a.d[a.a - 1]];
  if (0 !== a.b.a && u(Ga(a.b), b)) return Ka(a.b);
  do --a.a;
  while (0 < a.a && null === a.c[a.d[a.a - 1]]);
  return b;
}
function Ha() {
  this.d = Ja([0], 33);
  this.e = [null, null];
  this.c = [0, 0];
  this.a = 0;
  this.f = 32;
  this.b = 0;
  this.h = !1;
  this.d[1] = 1;
}
function Ja(a, b) {
  for (var c = Array(b), d = 0; d < a.length; d++) c[d] = a[d];
  for (; d < b; d++) c[d] = 0;
  return c;
}
function Ia(a) {
  for (var b = a.a; 1 <= b; --b) W(a, b);
  a.h = !0;
}
function Ga(a) {
  return a.e[a.d[1]];
}
function Ka(a) {
  var b = a.d,
    c = a.e,
    d = a.c,
    e = b[1],
    f = c[e];
  0 < a.a &&
    ((b[1] = b[a.a]),
    (d[b[1]] = 1),
    (c[e] = null),
    (d[e] = a.b),
    (a.b = e),
    0 < --a.a && W(a, 1));
  return f;
}
function W(a, b) {
  for (var c = a.d, d = a.e, e = a.c, f = b, g = c[f]; ; ) {
    var h = f << 1;
    h < a.a && u(d[c[h + 1]], d[c[h]]) && (h += 1);
    var k = c[h];
    if (h > a.a || u(d[g], d[k])) {
      c[f] = g;
      e[g] = f;
      break;
    }
    c[f] = k;
    e[k] = f;
    f = h;
  }
}
function va(a, b) {
  for (var c = a.d, d = a.e, e = a.c, f = b, g = c[f]; ; ) {
    var h = f >> 1,
      k = c[h];
    if (0 === h || u(d[k], d[g])) {
      c[f] = g;
      e[g] = f;
      break;
    }
    c[f] = k;
    e[k] = f;
    f = h;
  }
}
function ma() {
  this.e = this.a = null;
  this.f = 0;
  this.c = this.b = this.h = this.d = !1;
}
function S(a) {
  return a.e.c.b;
}
function R(a) {
  return a.e.a.b;
}
this.libtess = {
  GluTesselator: X,
  windingRule: {
    GLU_TESS_WINDING_ODD: 100130,
    GLU_TESS_WINDING_NONZERO: 100131,
    GLU_TESS_WINDING_POSITIVE: 100132,
    GLU_TESS_WINDING_NEGATIVE: 100133,
    GLU_TESS_WINDING_ABS_GEQ_TWO: 100134,
  },
  primitiveType: {
    GL_LINE_LOOP: 2,
    GL_TRIANGLES: 4,
    GL_TRIANGLE_STRIP: 5,
    GL_TRIANGLE_FAN: 6,
  },
  errorType: {
    GLU_TESS_MISSING_BEGIN_POLYGON: 100151,
    GLU_TESS_MISSING_END_POLYGON: 100153,
    GLU_TESS_MISSING_BEGIN_CONTOUR: 100152,
    GLU_TESS_MISSING_END_CONTOUR: 100154,
    GLU_TESS_COORD_TOO_LARGE: 100155,
    GLU_TESS_NEED_COMBINE_CALLBACK: 100156,
  },
  gluEnum: {
    GLU_TESS_MESH: 100112,
    GLU_TESS_TOLERANCE: 100142,
    GLU_TESS_WINDING_RULE: 100140,
    GLU_TESS_BOUNDARY_ONLY: 100141,
    GLU_INVALID_ENUM: 100900,
    GLU_INVALID_VALUE: 100901,
    GLU_TESS_BEGIN: 100100,
    GLU_TESS_VERTEX: 100101,
    GLU_TESS_END: 100102,
    GLU_TESS_ERROR: 100103,
    GLU_TESS_EDGE_FLAG: 100104,
    GLU_TESS_COMBINE: 100105,
    GLU_TESS_BEGIN_DATA: 100106,
    GLU_TESS_VERTEX_DATA: 100107,
    GLU_TESS_END_DATA: 100108,
    GLU_TESS_ERROR_DATA: 100109,
    GLU_TESS_EDGE_FLAG_DATA: 100110,
    GLU_TESS_COMBINE_DATA: 100111,
  },
};
X.prototype.gluDeleteTess = X.prototype.x;
X.prototype.gluTessProperty = X.prototype.B;
X.prototype.gluGetTessProperty = X.prototype.y;
X.prototype.gluTessNormal = X.prototype.A;
X.prototype.gluTessCallback = X.prototype.z;
X.prototype.gluTessVertex = X.prototype.C;
X.prototype.gluTessBeginPolygon = X.prototype.u;
X.prototype.gluTessBeginContour = X.prototype.t;
X.prototype.gluTessEndContour = X.prototype.v;
X.prototype.gluTessEndPolygon = X.prototype.w;
if (typeof module !== "undefined") {
  module.exports = this.libtess;
}

/*!
@fileoverview gl-matrix - High performance matrix and vector operations
@author Brandon Jones
@author Colin MacKenzie IV
@version 3.4.0

Copyright (c) 2015-2021, Brandon Jones, Colin MacKenzie IV.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

*/
!(function (t, n) {
  "object" == typeof exports && "undefined" != typeof module
    ? n(exports)
    : "function" == typeof define && define.amd
      ? define(["exports"], n)
      : n(
          ((t =
            "undefined" != typeof globalThis
              ? globalThis
              : t || self).glMatrix = {}),
        );
})(this, function (t) {
  "use strict";
  var n = 1e-6,
    a = "undefined" != typeof Float32Array ? Float32Array : Array,
    r = Math.random,
    u = "zyx";
  var e = Math.PI / 180;
  Math.hypot ||
    (Math.hypot = function () {
      for (var t = 0, n = arguments.length; n--; )
        t += arguments[n] * arguments[n];
      return Math.sqrt(t);
    });
  var o = Object.freeze({
    __proto__: null,
    EPSILON: n,
    get ARRAY_TYPE() {
      return a;
    },
    RANDOM: r,
    ANGLE_ORDER: u,
    setMatrixArrayType: function (t) {
      a = t;
    },
    toRadian: function (t) {
      return t * e;
    },
    equals: function (t, a) {
      return Math.abs(t - a) <= n * Math.max(1, Math.abs(t), Math.abs(a));
    },
  });
  function i(t, n, a) {
    var r = n[0],
      u = n[1],
      e = n[2],
      o = n[3],
      i = a[0],
      h = a[1],
      c = a[2],
      s = a[3];
    return (
      (t[0] = r * i + e * h),
      (t[1] = u * i + o * h),
      (t[2] = r * c + e * s),
      (t[3] = u * c + o * s),
      t
    );
  }
  function h(t, n, a) {
    return (
      (t[0] = n[0] - a[0]),
      (t[1] = n[1] - a[1]),
      (t[2] = n[2] - a[2]),
      (t[3] = n[3] - a[3]),
      t
    );
  }
  var c = i,
    s = h,
    M = Object.freeze({
      __proto__: null,
      create: function () {
        var t = new a(4);
        return (
          a != Float32Array && ((t[1] = 0), (t[2] = 0)),
          (t[0] = 1),
          (t[3] = 1),
          t
        );
      },
      clone: function (t) {
        var n = new a(4);
        return (n[0] = t[0]), (n[1] = t[1]), (n[2] = t[2]), (n[3] = t[3]), n;
      },
      copy: function (t, n) {
        return (t[0] = n[0]), (t[1] = n[1]), (t[2] = n[2]), (t[3] = n[3]), t;
      },
      identity: function (t) {
        return (t[0] = 1), (t[1] = 0), (t[2] = 0), (t[3] = 1), t;
      },
      fromValues: function (t, n, r, u) {
        var e = new a(4);
        return (e[0] = t), (e[1] = n), (e[2] = r), (e[3] = u), e;
      },
      set: function (t, n, a, r, u) {
        return (t[0] = n), (t[1] = a), (t[2] = r), (t[3] = u), t;
      },
      transpose: function (t, n) {
        if (t === n) {
          var a = n[1];
          (t[1] = n[2]), (t[2] = a);
        } else (t[0] = n[0]), (t[1] = n[2]), (t[2] = n[1]), (t[3] = n[3]);
        return t;
      },
      invert: function (t, n) {
        var a = n[0],
          r = n[1],
          u = n[2],
          e = n[3],
          o = a * e - u * r;
        return o
          ? ((o = 1 / o),
            (t[0] = e * o),
            (t[1] = -r * o),
            (t[2] = -u * o),
            (t[3] = a * o),
            t)
          : null;
      },
      adjoint: function (t, n) {
        var a = n[0];
        return (t[0] = n[3]), (t[1] = -n[1]), (t[2] = -n[2]), (t[3] = a), t;
      },
      determinant: function (t) {
        return t[0] * t[3] - t[2] * t[1];
      },
      multiply: i,
      rotate: function (t, n, a) {
        var r = n[0],
          u = n[1],
          e = n[2],
          o = n[3],
          i = Math.sin(a),
          h = Math.cos(a);
        return (
          (t[0] = r * h + e * i),
          (t[1] = u * h + o * i),
          (t[2] = r * -i + e * h),
          (t[3] = u * -i + o * h),
          t
        );
      },
      scale: function (t, n, a) {
        var r = n[0],
          u = n[1],
          e = n[2],
          o = n[3],
          i = a[0],
          h = a[1];
        return (
          (t[0] = r * i), (t[1] = u * i), (t[2] = e * h), (t[3] = o * h), t
        );
      },
      fromRotation: function (t, n) {
        var a = Math.sin(n),
          r = Math.cos(n);
        return (t[0] = r), (t[1] = a), (t[2] = -a), (t[3] = r), t;
      },
      fromScaling: function (t, n) {
        return (t[0] = n[0]), (t[1] = 0), (t[2] = 0), (t[3] = n[1]), t;
      },
      str: function (t) {
        return "mat2(" + t[0] + ", " + t[1] + ", " + t[2] + ", " + t[3] + ")";
      },
      frob: function (t) {
        return Math.hypot(t[0], t[1], t[2], t[3]);
      },
      LDU: function (t, n, a, r) {
        return (
          (t[2] = r[2] / r[0]),
          (a[0] = r[0]),
          (a[1] = r[1]),
          (a[3] = r[3] - t[2] * a[1]),
          [t, n, a]
        );
      },
      add: function (t, n, a) {
        return (
          (t[0] = n[0] + a[0]),
          (t[1] = n[1] + a[1]),
          (t[2] = n[2] + a[2]),
          (t[3] = n[3] + a[3]),
          t
        );
      },
      subtract: h,
      exactEquals: function (t, n) {
        return t[0] === n[0] && t[1] === n[1] && t[2] === n[2] && t[3] === n[3];
      },
      equals: function (t, a) {
        var r = t[0],
          u = t[1],
          e = t[2],
          o = t[3],
          i = a[0],
          h = a[1],
          c = a[2],
          s = a[3];
        return (
          Math.abs(r - i) <= n * Math.max(1, Math.abs(r), Math.abs(i)) &&
          Math.abs(u - h) <= n * Math.max(1, Math.abs(u), Math.abs(h)) &&
          Math.abs(e - c) <= n * Math.max(1, Math.abs(e), Math.abs(c)) &&
          Math.abs(o - s) <= n * Math.max(1, Math.abs(o), Math.abs(s))
        );
      },
      multiplyScalar: function (t, n, a) {
        return (
          (t[0] = n[0] * a),
          (t[1] = n[1] * a),
          (t[2] = n[2] * a),
          (t[3] = n[3] * a),
          t
        );
      },
      multiplyScalarAndAdd: function (t, n, a, r) {
        return (
          (t[0] = n[0] + a[0] * r),
          (t[1] = n[1] + a[1] * r),
          (t[2] = n[2] + a[2] * r),
          (t[3] = n[3] + a[3] * r),
          t
        );
      },
      mul: c,
      sub: s,
    });
  function f(t, n, a) {
    var r = n[0],
      u = n[1],
      e = n[2],
      o = n[3],
      i = n[4],
      h = n[5],
      c = a[0],
      s = a[1],
      M = a[2],
      f = a[3],
      l = a[4],
      v = a[5];
    return (
      (t[0] = r * c + e * s),
      (t[1] = u * c + o * s),
      (t[2] = r * M + e * f),
      (t[3] = u * M + o * f),
      (t[4] = r * l + e * v + i),
      (t[5] = u * l + o * v + h),
      t
    );
  }
  function l(t, n, a) {
    return (
      (t[0] = n[0] - a[0]),
      (t[1] = n[1] - a[1]),
      (t[2] = n[2] - a[2]),
      (t[3] = n[3] - a[3]),
      (t[4] = n[4] - a[4]),
      (t[5] = n[5] - a[5]),
      t
    );
  }
  var v = f,
    b = l,
    m = Object.freeze({
      __proto__: null,
      create: function () {
        var t = new a(6);
        return (
          a != Float32Array && ((t[1] = 0), (t[2] = 0), (t[4] = 0), (t[5] = 0)),
          (t[0] = 1),
          (t[3] = 1),
          t
        );
      },
      clone: function (t) {
        var n = new a(6);
        return (
          (n[0] = t[0]),
          (n[1] = t[1]),
          (n[2] = t[2]),
          (n[3] = t[3]),
          (n[4] = t[4]),
          (n[5] = t[5]),
          n
        );
      },
      copy: function (t, n) {
        return (
          (t[0] = n[0]),
          (t[1] = n[1]),
          (t[2] = n[2]),
          (t[3] = n[3]),
          (t[4] = n[4]),
          (t[5] = n[5]),
          t
        );
      },
      identity: function (t) {
        return (
          (t[0] = 1),
          (t[1] = 0),
          (t[2] = 0),
          (t[3] = 1),
          (t[4] = 0),
          (t[5] = 0),
          t
        );
      },
      fromValues: function (t, n, r, u, e, o) {
        var i = new a(6);
        return (
          (i[0] = t),
          (i[1] = n),
          (i[2] = r),
          (i[3] = u),
          (i[4] = e),
          (i[5] = o),
          i
        );
      },
      set: function (t, n, a, r, u, e, o) {
        return (
          (t[0] = n),
          (t[1] = a),
          (t[2] = r),
          (t[3] = u),
          (t[4] = e),
          (t[5] = o),
          t
        );
      },
      invert: function (t, n) {
        var a = n[0],
          r = n[1],
          u = n[2],
          e = n[3],
          o = n[4],
          i = n[5],
          h = a * e - r * u;
        return h
          ? ((h = 1 / h),
            (t[0] = e * h),
            (t[1] = -r * h),
            (t[2] = -u * h),
            (t[3] = a * h),
            (t[4] = (u * i - e * o) * h),
            (t[5] = (r * o - a * i) * h),
            t)
          : null;
      },
      determinant: function (t) {
        return t[0] * t[3] - t[1] * t[2];
      },
      multiply: f,
      rotate: function (t, n, a) {
        var r = n[0],
          u = n[1],
          e = n[2],
          o = n[3],
          i = n[4],
          h = n[5],
          c = Math.sin(a),
          s = Math.cos(a);
        return (
          (t[0] = r * s + e * c),
          (t[1] = u * s + o * c),
          (t[2] = r * -c + e * s),
          (t[3] = u * -c + o * s),
          (t[4] = i),
          (t[5] = h),
          t
        );
      },
      scale: function (t, n, a) {
        var r = n[0],
          u = n[1],
          e = n[2],
          o = n[3],
          i = n[4],
          h = n[5],
          c = a[0],
          s = a[1];
        return (
          (t[0] = r * c),
          (t[1] = u * c),
          (t[2] = e * s),
          (t[3] = o * s),
          (t[4] = i),
          (t[5] = h),
          t
        );
      },
      translate: function (t, n, a) {
        var r = n[0],
          u = n[1],
          e = n[2],
          o = n[3],
          i = n[4],
          h = n[5],
          c = a[0],
          s = a[1];
        return (
          (t[0] = r),
          (t[1] = u),
          (t[2] = e),
          (t[3] = o),
          (t[4] = r * c + e * s + i),
          (t[5] = u * c + o * s + h),
          t
        );
      },
      fromRotation: function (t, n) {
        var a = Math.sin(n),
          r = Math.cos(n);
        return (
          (t[0] = r),
          (t[1] = a),
          (t[2] = -a),
          (t[3] = r),
          (t[4] = 0),
          (t[5] = 0),
          t
        );
      },
      fromScaling: function (t, n) {
        return (
          (t[0] = n[0]),
          (t[1] = 0),
          (t[2] = 0),
          (t[3] = n[1]),
          (t[4] = 0),
          (t[5] = 0),
          t
        );
      },
      fromTranslation: function (t, n) {
        return (
          (t[0] = 1),
          (t[1] = 0),
          (t[2] = 0),
          (t[3] = 1),
          (t[4] = n[0]),
          (t[5] = n[1]),
          t
        );
      },
      str: function (t) {
        return (
          "mat2d(" +
          t[0] +
          ", " +
          t[1] +
          ", " +
          t[2] +
          ", " +
          t[3] +
          ", " +
          t[4] +
          ", " +
          t[5] +
          ")"
        );
      },
      frob: function (t) {
        return Math.hypot(t[0], t[1], t[2], t[3], t[4], t[5], 1);
      },
      add: function (t, n, a) {
        return (
          (t[0] = n[0] + a[0]),
          (t[1] = n[1] + a[1]),
          (t[2] = n[2] + a[2]),
          (t[3] = n[3] + a[3]),
          (t[4] = n[4] + a[4]),
          (t[5] = n[5] + a[5]),
          t
        );
      },
      subtract: l,
      multiplyScalar: function (t, n, a) {
        return (
          (t[0] = n[0] * a),
          (t[1] = n[1] * a),
          (t[2] = n[2] * a),
          (t[3] = n[3] * a),
          (t[4] = n[4] * a),
          (t[5] = n[5] * a),
          t
        );
      },
      multiplyScalarAndAdd: function (t, n, a, r) {
        return (
          (t[0] = n[0] + a[0] * r),
          (t[1] = n[1] + a[1] * r),
          (t[2] = n[2] + a[2] * r),
          (t[3] = n[3] + a[3] * r),
          (t[4] = n[4] + a[4] * r),
          (t[5] = n[5] + a[5] * r),
          t
        );
      },
      exactEquals: function (t, n) {
        return (
          t[0] === n[0] &&
          t[1] === n[1] &&
          t[2] === n[2] &&
          t[3] === n[3] &&
          t[4] === n[4] &&
          t[5] === n[5]
        );
      },
      equals: function (t, a) {
        var r = t[0],
          u = t[1],
          e = t[2],
          o = t[3],
          i = t[4],
          h = t[5],
          c = a[0],
          s = a[1],
          M = a[2],
          f = a[3],
          l = a[4],
          v = a[5];
        return (
          Math.abs(r - c) <= n * Math.max(1, Math.abs(r), Math.abs(c)) &&
          Math.abs(u - s) <= n * Math.max(1, Math.abs(u), Math.abs(s)) &&
          Math.abs(e - M) <= n * Math.max(1, Math.abs(e), Math.abs(M)) &&
          Math.abs(o - f) <= n * Math.max(1, Math.abs(o), Math.abs(f)) &&
          Math.abs(i - l) <= n * Math.max(1, Math.abs(i), Math.abs(l)) &&
          Math.abs(h - v) <= n * Math.max(1, Math.abs(h), Math.abs(v))
        );
      },
      mul: v,
      sub: b,
    });
  function d() {
    var t = new a(9);
    return (
      a != Float32Array &&
        ((t[1] = 0),
        (t[2] = 0),
        (t[3] = 0),
        (t[5] = 0),
        (t[6] = 0),
        (t[7] = 0)),
      (t[0] = 1),
      (t[4] = 1),
      (t[8] = 1),
      t
    );
  }
  function p(t, n, a) {
    var r = n[0],
      u = n[1],
      e = n[2],
      o = n[3],
      i = n[4],
      h = n[5],
      c = n[6],
      s = n[7],
      M = n[8],
      f = a[0],
      l = a[1],
      v = a[2],
      b = a[3],
      m = a[4],
      d = a[5],
      p = a[6],
      x = a[7],
      y = a[8];
    return (
      (t[0] = f * r + l * o + v * c),
      (t[1] = f * u + l * i + v * s),
      (t[2] = f * e + l * h + v * M),
      (t[3] = b * r + m * o + d * c),
      (t[4] = b * u + m * i + d * s),
      (t[5] = b * e + m * h + d * M),
      (t[6] = p * r + x * o + y * c),
      (t[7] = p * u + x * i + y * s),
      (t[8] = p * e + x * h + y * M),
      t
    );
  }
  function x(t, n, a) {
    return (
      (t[0] = n[0] - a[0]),
      (t[1] = n[1] - a[1]),
      (t[2] = n[2] - a[2]),
      (t[3] = n[3] - a[3]),
      (t[4] = n[4] - a[4]),
      (t[5] = n[5] - a[5]),
      (t[6] = n[6] - a[6]),
      (t[7] = n[7] - a[7]),
      (t[8] = n[8] - a[8]),
      t
    );
  }
  var y = p,
    q = x,
    g = Object.freeze({
      __proto__: null,
      create: d,
      fromMat4: function (t, n) {
        return (
          (t[0] = n[0]),
          (t[1] = n[1]),
          (t[2] = n[2]),
          (t[3] = n[4]),
          (t[4] = n[5]),
          (t[5] = n[6]),
          (t[6] = n[8]),
          (t[7] = n[9]),
          (t[8] = n[10]),
          t
        );
      },
      clone: function (t) {
        var n = new a(9);
        return (
          (n[0] = t[0]),
          (n[1] = t[1]),
          (n[2] = t[2]),
          (n[3] = t[3]),
          (n[4] = t[4]),
          (n[5] = t[5]),
          (n[6] = t[6]),
          (n[7] = t[7]),
          (n[8] = t[8]),
          n
        );
      },
      copy: function (t, n) {
        return (
          (t[0] = n[0]),
          (t[1] = n[1]),
          (t[2] = n[2]),
          (t[3] = n[3]),
          (t[4] = n[4]),
          (t[5] = n[5]),
          (t[6] = n[6]),
          (t[7] = n[7]),
          (t[8] = n[8]),
          t
        );
      },
      fromValues: function (t, n, r, u, e, o, i, h, c) {
        var s = new a(9);
        return (
          (s[0] = t),
          (s[1] = n),
          (s[2] = r),
          (s[3] = u),
          (s[4] = e),
          (s[5] = o),
          (s[6] = i),
          (s[7] = h),
          (s[8] = c),
          s
        );
      },
      set: function (t, n, a, r, u, e, o, i, h, c) {
        return (
          (t[0] = n),
          (t[1] = a),
          (t[2] = r),
          (t[3] = u),
          (t[4] = e),
          (t[5] = o),
          (t[6] = i),
          (t[7] = h),
          (t[8] = c),
          t
        );
      },
      identity: function (t) {
        return (
          (t[0] = 1),
          (t[1] = 0),
          (t[2] = 0),
          (t[3] = 0),
          (t[4] = 1),
          (t[5] = 0),
          (t[6] = 0),
          (t[7] = 0),
          (t[8] = 1),
          t
        );
      },
      transpose: function (t, n) {
        if (t === n) {
          var a = n[1],
            r = n[2],
            u = n[5];
          (t[1] = n[3]),
            (t[2] = n[6]),
            (t[3] = a),
            (t[5] = n[7]),
            (t[6] = r),
            (t[7] = u);
        } else
          (t[0] = n[0]),
            (t[1] = n[3]),
            (t[2] = n[6]),
            (t[3] = n[1]),
            (t[4] = n[4]),
            (t[5] = n[7]),
            (t[6] = n[2]),
            (t[7] = n[5]),
            (t[8] = n[8]);
        return t;
      },
      invert: function (t, n) {
        var a = n[0],
          r = n[1],
          u = n[2],
          e = n[3],
          o = n[4],
          i = n[5],
          h = n[6],
          c = n[7],
          s = n[8],
          M = s * o - i * c,
          f = -s * e + i * h,
          l = c * e - o * h,
          v = a * M + r * f + u * l;
        return v
          ? ((v = 1 / v),
            (t[0] = M * v),
            (t[1] = (-s * r + u * c) * v),
            (t[2] = (i * r - u * o) * v),
            (t[3] = f * v),
            (t[4] = (s * a - u * h) * v),
            (t[5] = (-i * a + u * e) * v),
            (t[6] = l * v),
            (t[7] = (-c * a + r * h) * v),
            (t[8] = (o * a - r * e) * v),
            t)
          : null;
      },
      adjoint: function (t, n) {
        var a = n[0],
          r = n[1],
          u = n[2],
          e = n[3],
          o = n[4],
          i = n[5],
          h = n[6],
          c = n[7],
          s = n[8];
        return (
          (t[0] = o * s - i * c),
          (t[1] = u * c - r * s),
          (t[2] = r * i - u * o),
          (t[3] = i * h - e * s),
          (t[4] = a * s - u * h),
          (t[5] = u * e - a * i),
          (t[6] = e * c - o * h),
          (t[7] = r * h - a * c),
          (t[8] = a * o - r * e),
          t
        );
      },
      determinant: function (t) {
        var n = t[0],
          a = t[1],
          r = t[2],
          u = t[3],
          e = t[4],
          o = t[5],
          i = t[6],
          h = t[7],
          c = t[8];
        return n * (c * e - o * h) + a * (-c * u + o * i) + r * (h * u - e * i);
      },
      multiply: p,
      translate: function (t, n, a) {
        var r = n[0],
          u = n[1],
          e = n[2],
          o = n[3],
          i = n[4],
          h = n[5],
          c = n[6],
          s = n[7],
          M = n[8],
          f = a[0],
          l = a[1];
        return (
          (t[0] = r),
          (t[1] = u),
          (t[2] = e),
          (t[3] = o),
          (t[4] = i),
          (t[5] = h),
          (t[6] = f * r + l * o + c),
          (t[7] = f * u + l * i + s),
          (t[8] = f * e + l * h + M),
          t
        );
      },
      rotate: function (t, n, a) {
        var r = n[0],
          u = n[1],
          e = n[2],
          o = n[3],
          i = n[4],
          h = n[5],
          c = n[6],
          s = n[7],
          M = n[8],
          f = Math.sin(a),
          l = Math.cos(a);
        return (
          (t[0] = l * r + f * o),
          (t[1] = l * u + f * i),
          (t[2] = l * e + f * h),
          (t[3] = l * o - f * r),
          (t[4] = l * i - f * u),
          (t[5] = l * h - f * e),
          (t[6] = c),
          (t[7] = s),
          (t[8] = M),
          t
        );
      },
      scale: function (t, n, a) {
        var r = a[0],
          u = a[1];
        return (
          (t[0] = r * n[0]),
          (t[1] = r * n[1]),
          (t[2] = r * n[2]),
          (t[3] = u * n[3]),
          (t[4] = u * n[4]),
          (t[5] = u * n[5]),
          (t[6] = n[6]),
          (t[7] = n[7]),
          (t[8] = n[8]),
          t
        );
      },
      fromTranslation: function (t, n) {
        return (
          (t[0] = 1),
          (t[1] = 0),
          (t[2] = 0),
          (t[3] = 0),
          (t[4] = 1),
          (t[5] = 0),
          (t[6] = n[0]),
          (t[7] = n[1]),
          (t[8] = 1),
          t
        );
      },
      fromRotation: function (t, n) {
        var a = Math.sin(n),
          r = Math.cos(n);
        return (
          (t[0] = r),
          (t[1] = a),
          (t[2] = 0),
          (t[3] = -a),
          (t[4] = r),
          (t[5] = 0),
          (t[6] = 0),
          (t[7] = 0),
          (t[8] = 1),
          t
        );
      },
      fromScaling: function (t, n) {
        return (
          (t[0] = n[0]),
          (t[1] = 0),
          (t[2] = 0),
          (t[3] = 0),
          (t[4] = n[1]),
          (t[5] = 0),
          (t[6] = 0),
          (t[7] = 0),
          (t[8] = 1),
          t
        );
      },
      fromMat2d: function (t, n) {
        return (
          (t[0] = n[0]),
          (t[1] = n[1]),
          (t[2] = 0),
          (t[3] = n[2]),
          (t[4] = n[3]),
          (t[5] = 0),
          (t[6] = n[4]),
          (t[7] = n[5]),
          (t[8] = 1),
          t
        );
      },
      fromQuat: function (t, n) {
        var a = n[0],
          r = n[1],
          u = n[2],
          e = n[3],
          o = a + a,
          i = r + r,
          h = u + u,
          c = a * o,
          s = r * o,
          M = r * i,
          f = u * o,
          l = u * i,
          v = u * h,
          b = e * o,
          m = e * i,
          d = e * h;
        return (
          (t[0] = 1 - M - v),
          (t[3] = s - d),
          (t[6] = f + m),
          (t[1] = s + d),
          (t[4] = 1 - c - v),
          (t[7] = l - b),
          (t[2] = f - m),
          (t[5] = l + b),
          (t[8] = 1 - c - M),
          t
        );
      },
      normalFromMat4: function (t, n) {
        var a = n[0],
          r = n[1],
          u = n[2],
          e = n[3],
          o = n[4],
          i = n[5],
          h = n[6],
          c = n[7],
          s = n[8],
          M = n[9],
          f = n[10],
          l = n[11],
          v = n[12],
          b = n[13],
          m = n[14],
          d = n[15],
          p = a * i - r * o,
          x = a * h - u * o,
          y = a * c - e * o,
          q = r * h - u * i,
          g = r * c - e * i,
          _ = u * c - e * h,
          A = s * b - M * v,
          w = s * m - f * v,
          z = s * d - l * v,
          R = M * m - f * b,
          O = M * d - l * b,
          j = f * d - l * m,
          E = p * j - x * O + y * R + q * z - g * w + _ * A;
        return E
          ? ((E = 1 / E),
            (t[0] = (i * j - h * O + c * R) * E),
            (t[1] = (h * z - o * j - c * w) * E),
            (t[2] = (o * O - i * z + c * A) * E),
            (t[3] = (u * O - r * j - e * R) * E),
            (t[4] = (a * j - u * z + e * w) * E),
            (t[5] = (r * z - a * O - e * A) * E),
            (t[6] = (b * _ - m * g + d * q) * E),
            (t[7] = (m * y - v * _ - d * x) * E),
            (t[8] = (v * g - b * y + d * p) * E),
            t)
          : null;
      },
      projection: function (t, n, a) {
        return (
          (t[0] = 2 / n),
          (t[1] = 0),
          (t[2] = 0),
          (t[3] = 0),
          (t[4] = -2 / a),
          (t[5] = 0),
          (t[6] = -1),
          (t[7] = 1),
          (t[8] = 1),
          t
        );
      },
      str: function (t) {
        return (
          "mat3(" +
          t[0] +
          ", " +
          t[1] +
          ", " +
          t[2] +
          ", " +
          t[3] +
          ", " +
          t[4] +
          ", " +
          t[5] +
          ", " +
          t[6] +
          ", " +
          t[7] +
          ", " +
          t[8] +
          ")"
        );
      },
      frob: function (t) {
        return Math.hypot(t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8]);
      },
      add: function (t, n, a) {
        return (
          (t[0] = n[0] + a[0]),
          (t[1] = n[1] + a[1]),
          (t[2] = n[2] + a[2]),
          (t[3] = n[3] + a[3]),
          (t[4] = n[4] + a[4]),
          (t[5] = n[5] + a[5]),
          (t[6] = n[6] + a[6]),
          (t[7] = n[7] + a[7]),
          (t[8] = n[8] + a[8]),
          t
        );
      },
      subtract: x,
      multiplyScalar: function (t, n, a) {
        return (
          (t[0] = n[0] * a),
          (t[1] = n[1] * a),
          (t[2] = n[2] * a),
          (t[3] = n[3] * a),
          (t[4] = n[4] * a),
          (t[5] = n[5] * a),
          (t[6] = n[6] * a),
          (t[7] = n[7] * a),
          (t[8] = n[8] * a),
          t
        );
      },
      multiplyScalarAndAdd: function (t, n, a, r) {
        return (
          (t[0] = n[0] + a[0] * r),
          (t[1] = n[1] + a[1] * r),
          (t[2] = n[2] + a[2] * r),
          (t[3] = n[3] + a[3] * r),
          (t[4] = n[4] + a[4] * r),
          (t[5] = n[5] + a[5] * r),
          (t[6] = n[6] + a[6] * r),
          (t[7] = n[7] + a[7] * r),
          (t[8] = n[8] + a[8] * r),
          t
        );
      },
      exactEquals: function (t, n) {
        return (
          t[0] === n[0] &&
          t[1] === n[1] &&
          t[2] === n[2] &&
          t[3] === n[3] &&
          t[4] === n[4] &&
          t[5] === n[5] &&
          t[6] === n[6] &&
          t[7] === n[7] &&
          t[8] === n[8]
        );
      },
      equals: function (t, a) {
        var r = t[0],
          u = t[1],
          e = t[2],
          o = t[3],
          i = t[4],
          h = t[5],
          c = t[6],
          s = t[7],
          M = t[8],
          f = a[0],
          l = a[1],
          v = a[2],
          b = a[3],
          m = a[4],
          d = a[5],
          p = a[6],
          x = a[7],
          y = a[8];
        return (
          Math.abs(r - f) <= n * Math.max(1, Math.abs(r), Math.abs(f)) &&
          Math.abs(u - l) <= n * Math.max(1, Math.abs(u), Math.abs(l)) &&
          Math.abs(e - v) <= n * Math.max(1, Math.abs(e), Math.abs(v)) &&
          Math.abs(o - b) <= n * Math.max(1, Math.abs(o), Math.abs(b)) &&
          Math.abs(i - m) <= n * Math.max(1, Math.abs(i), Math.abs(m)) &&
          Math.abs(h - d) <= n * Math.max(1, Math.abs(h), Math.abs(d)) &&
          Math.abs(c - p) <= n * Math.max(1, Math.abs(c), Math.abs(p)) &&
          Math.abs(s - x) <= n * Math.max(1, Math.abs(s), Math.abs(x)) &&
          Math.abs(M - y) <= n * Math.max(1, Math.abs(M), Math.abs(y))
        );
      },
      mul: y,
      sub: q,
    });
  function _(t) {
    return (
      (t[0] = 1),
      (t[1] = 0),
      (t[2] = 0),
      (t[3] = 0),
      (t[4] = 0),
      (t[5] = 1),
      (t[6] = 0),
      (t[7] = 0),
      (t[8] = 0),
      (t[9] = 0),
      (t[10] = 1),
      (t[11] = 0),
      (t[12] = 0),
      (t[13] = 0),
      (t[14] = 0),
      (t[15] = 1),
      t
    );
  }
  function A(t, n, a) {
    var r = n[0],
      u = n[1],
      e = n[2],
      o = n[3],
      i = n[4],
      h = n[5],
      c = n[6],
      s = n[7],
      M = n[8],
      f = n[9],
      l = n[10],
      v = n[11],
      b = n[12],
      m = n[13],
      d = n[14],
      p = n[15],
      x = a[0],
      y = a[1],
      q = a[2],
      g = a[3];
    return (
      (t[0] = x * r + y * i + q * M + g * b),
      (t[1] = x * u + y * h + q * f + g * m),
      (t[2] = x * e + y * c + q * l + g * d),
      (t[3] = x * o + y * s + q * v + g * p),
      (x = a[4]),
      (y = a[5]),
      (q = a[6]),
      (g = a[7]),
      (t[4] = x * r + y * i + q * M + g * b),
      (t[5] = x * u + y * h + q * f + g * m),
      (t[6] = x * e + y * c + q * l + g * d),
      (t[7] = x * o + y * s + q * v + g * p),
      (x = a[8]),
      (y = a[9]),
      (q = a[10]),
      (g = a[11]),
      (t[8] = x * r + y * i + q * M + g * b),
      (t[9] = x * u + y * h + q * f + g * m),
      (t[10] = x * e + y * c + q * l + g * d),
      (t[11] = x * o + y * s + q * v + g * p),
      (x = a[12]),
      (y = a[13]),
      (q = a[14]),
      (g = a[15]),
      (t[12] = x * r + y * i + q * M + g * b),
      (t[13] = x * u + y * h + q * f + g * m),
      (t[14] = x * e + y * c + q * l + g * d),
      (t[15] = x * o + y * s + q * v + g * p),
      t
    );
  }
  function w(t, n, a) {
    var r = n[0],
      u = n[1],
      e = n[2],
      o = n[3],
      i = r + r,
      h = u + u,
      c = e + e,
      s = r * i,
      M = r * h,
      f = r * c,
      l = u * h,
      v = u * c,
      b = e * c,
      m = o * i,
      d = o * h,
      p = o * c;
    return (
      (t[0] = 1 - (l + b)),
      (t[1] = M + p),
      (t[2] = f - d),
      (t[3] = 0),
      (t[4] = M - p),
      (t[5] = 1 - (s + b)),
      (t[6] = v + m),
      (t[7] = 0),
      (t[8] = f + d),
      (t[9] = v - m),
      (t[10] = 1 - (s + l)),
      (t[11] = 0),
      (t[12] = a[0]),
      (t[13] = a[1]),
      (t[14] = a[2]),
      (t[15] = 1),
      t
    );
  }
  function z(t, n) {
    return (t[0] = n[12]), (t[1] = n[13]), (t[2] = n[14]), t;
  }
  function R(t, n) {
    var a = n[0],
      r = n[1],
      u = n[2],
      e = n[4],
      o = n[5],
      i = n[6],
      h = n[8],
      c = n[9],
      s = n[10];
    return (
      (t[0] = Math.hypot(a, r, u)),
      (t[1] = Math.hypot(e, o, i)),
      (t[2] = Math.hypot(h, c, s)),
      t
    );
  }
  function O(t, n) {
    var r = new a(3);
    R(r, n);
    var u = 1 / r[0],
      e = 1 / r[1],
      o = 1 / r[2],
      i = n[0] * u,
      h = n[1] * e,
      c = n[2] * o,
      s = n[4] * u,
      M = n[5] * e,
      f = n[6] * o,
      l = n[8] * u,
      v = n[9] * e,
      b = n[10] * o,
      m = i + M + b,
      d = 0;
    return (
      m > 0
        ? ((d = 2 * Math.sqrt(m + 1)),
          (t[3] = 0.25 * d),
          (t[0] = (f - v) / d),
          (t[1] = (l - c) / d),
          (t[2] = (h - s) / d))
        : i > M && i > b
          ? ((d = 2 * Math.sqrt(1 + i - M - b)),
            (t[3] = (f - v) / d),
            (t[0] = 0.25 * d),
            (t[1] = (h + s) / d),
            (t[2] = (l + c) / d))
          : M > b
            ? ((d = 2 * Math.sqrt(1 + M - i - b)),
              (t[3] = (l - c) / d),
              (t[0] = (h + s) / d),
              (t[1] = 0.25 * d),
              (t[2] = (f + v) / d))
            : ((d = 2 * Math.sqrt(1 + b - i - M)),
              (t[3] = (h - s) / d),
              (t[0] = (l + c) / d),
              (t[1] = (f + v) / d),
              (t[2] = 0.25 * d)),
      t
    );
  }
  function j(t, n, a, r, u) {
    var e = 1 / Math.tan(n / 2);
    if (
      ((t[0] = e / a),
      (t[1] = 0),
      (t[2] = 0),
      (t[3] = 0),
      (t[4] = 0),
      (t[5] = e),
      (t[6] = 0),
      (t[7] = 0),
      (t[8] = 0),
      (t[9] = 0),
      (t[11] = -1),
      (t[12] = 0),
      (t[13] = 0),
      (t[15] = 0),
      null != u && u !== 1 / 0)
    ) {
      var o = 1 / (r - u);
      (t[10] = (u + r) * o), (t[14] = 2 * u * r * o);
    } else (t[10] = -1), (t[14] = -2 * r);
    return t;
  }
  var E = j;
  function P(t, n, a, r, u, e, o) {
    var i = 1 / (n - a),
      h = 1 / (r - u),
      c = 1 / (e - o);
    return (
      (t[0] = -2 * i),
      (t[1] = 0),
      (t[2] = 0),
      (t[3] = 0),
      (t[4] = 0),
      (t[5] = -2 * h),
      (t[6] = 0),
      (t[7] = 0),
      (t[8] = 0),
      (t[9] = 0),
      (t[10] = 2 * c),
      (t[11] = 0),
      (t[12] = (n + a) * i),
      (t[13] = (u + r) * h),
      (t[14] = (o + e) * c),
      (t[15] = 1),
      t
    );
  }
  var T = P;
  function S(t, n, a) {
    return (
      (t[0] = n[0] - a[0]),
      (t[1] = n[1] - a[1]),
      (t[2] = n[2] - a[2]),
      (t[3] = n[3] - a[3]),
      (t[4] = n[4] - a[4]),
      (t[5] = n[5] - a[5]),
      (t[6] = n[6] - a[6]),
      (t[7] = n[7] - a[7]),
      (t[8] = n[8] - a[8]),
      (t[9] = n[9] - a[9]),
      (t[10] = n[10] - a[10]),
      (t[11] = n[11] - a[11]),
      (t[12] = n[12] - a[12]),
      (t[13] = n[13] - a[13]),
      (t[14] = n[14] - a[14]),
      (t[15] = n[15] - a[15]),
      t
    );
  }
  var D = A,
    F = S,
    I = Object.freeze({
      __proto__: null,
      create: function () {
        var t = new a(16);
        return (
          a != Float32Array &&
            ((t[1] = 0),
            (t[2] = 0),
            (t[3] = 0),
            (t[4] = 0),
            (t[6] = 0),
            (t[7] = 0),
            (t[8] = 0),
            (t[9] = 0),
            (t[11] = 0),
            (t[12] = 0),
            (t[13] = 0),
            (t[14] = 0)),
          (t[0] = 1),
          (t[5] = 1),
          (t[10] = 1),
          (t[15] = 1),
          t
        );
      },
      clone: function (t) {
        var n = new a(16);
        return (
          (n[0] = t[0]),
          (n[1] = t[1]),
          (n[2] = t[2]),
          (n[3] = t[3]),
          (n[4] = t[4]),
          (n[5] = t[5]),
          (n[6] = t[6]),
          (n[7] = t[7]),
          (n[8] = t[8]),
          (n[9] = t[9]),
          (n[10] = t[10]),
          (n[11] = t[11]),
          (n[12] = t[12]),
          (n[13] = t[13]),
          (n[14] = t[14]),
          (n[15] = t[15]),
          n
        );
      },
      copy: function (t, n) {
        return (
          (t[0] = n[0]),
          (t[1] = n[1]),
          (t[2] = n[2]),
          (t[3] = n[3]),
          (t[4] = n[4]),
          (t[5] = n[5]),
          (t[6] = n[6]),
          (t[7] = n[7]),
          (t[8] = n[8]),
          (t[9] = n[9]),
          (t[10] = n[10]),
          (t[11] = n[11]),
          (t[12] = n[12]),
          (t[13] = n[13]),
          (t[14] = n[14]),
          (t[15] = n[15]),
          t
        );
      },
      fromValues: function (t, n, r, u, e, o, i, h, c, s, M, f, l, v, b, m) {
        var d = new a(16);
        return (
          (d[0] = t),
          (d[1] = n),
          (d[2] = r),
          (d[3] = u),
          (d[4] = e),
          (d[5] = o),
          (d[6] = i),
          (d[7] = h),
          (d[8] = c),
          (d[9] = s),
          (d[10] = M),
          (d[11] = f),
          (d[12] = l),
          (d[13] = v),
          (d[14] = b),
          (d[15] = m),
          d
        );
      },
      set: function (t, n, a, r, u, e, o, i, h, c, s, M, f, l, v, b, m) {
        return (
          (t[0] = n),
          (t[1] = a),
          (t[2] = r),
          (t[3] = u),
          (t[4] = e),
          (t[5] = o),
          (t[6] = i),
          (t[7] = h),
          (t[8] = c),
          (t[9] = s),
          (t[10] = M),
          (t[11] = f),
          (t[12] = l),
          (t[13] = v),
          (t[14] = b),
          (t[15] = m),
          t
        );
      },
      identity: _,
      transpose: function (t, n) {
        if (t === n) {
          var a = n[1],
            r = n[2],
            u = n[3],
            e = n[6],
            o = n[7],
            i = n[11];
          (t[1] = n[4]),
            (t[2] = n[8]),
            (t[3] = n[12]),
            (t[4] = a),
            (t[6] = n[9]),
            (t[7] = n[13]),
            (t[8] = r),
            (t[9] = e),
            (t[11] = n[14]),
            (t[12] = u),
            (t[13] = o),
            (t[14] = i);
        } else
          (t[0] = n[0]),
            (t[1] = n[4]),
            (t[2] = n[8]),
            (t[3] = n[12]),
            (t[4] = n[1]),
            (t[5] = n[5]),
            (t[6] = n[9]),
            (t[7] = n[13]),
            (t[8] = n[2]),
            (t[9] = n[6]),
            (t[10] = n[10]),
            (t[11] = n[14]),
            (t[12] = n[3]),
            (t[13] = n[7]),
            (t[14] = n[11]),
            (t[15] = n[15]);
        return t;
      },
      invert: function (t, n) {
        var a = n[0],
          r = n[1],
          u = n[2],
          e = n[3],
          o = n[4],
          i = n[5],
          h = n[6],
          c = n[7],
          s = n[8],
          M = n[9],
          f = n[10],
          l = n[11],
          v = n[12],
          b = n[13],
          m = n[14],
          d = n[15],
          p = a * i - r * o,
          x = a * h - u * o,
          y = a * c - e * o,
          q = r * h - u * i,
          g = r * c - e * i,
          _ = u * c - e * h,
          A = s * b - M * v,
          w = s * m - f * v,
          z = s * d - l * v,
          R = M * m - f * b,
          O = M * d - l * b,
          j = f * d - l * m,
          E = p * j - x * O + y * R + q * z - g * w + _ * A;
        return E
          ? ((E = 1 / E),
            (t[0] = (i * j - h * O + c * R) * E),
            (t[1] = (u * O - r * j - e * R) * E),
            (t[2] = (b * _ - m * g + d * q) * E),
            (t[3] = (f * g - M * _ - l * q) * E),
            (t[4] = (h * z - o * j - c * w) * E),
            (t[5] = (a * j - u * z + e * w) * E),
            (t[6] = (m * y - v * _ - d * x) * E),
            (t[7] = (s * _ - f * y + l * x) * E),
            (t[8] = (o * O - i * z + c * A) * E),
            (t[9] = (r * z - a * O - e * A) * E),
            (t[10] = (v * g - b * y + d * p) * E),
            (t[11] = (M * y - s * g - l * p) * E),
            (t[12] = (i * w - o * R - h * A) * E),
            (t[13] = (a * R - r * w + u * A) * E),
            (t[14] = (b * x - v * q - m * p) * E),
            (t[15] = (s * q - M * x + f * p) * E),
            t)
          : null;
      },
      adjoint: function (t, n) {
        var a = n[0],
          r = n[1],
          u = n[2],
          e = n[3],
          o = n[4],
          i = n[5],
          h = n[6],
          c = n[7],
          s = n[8],
          M = n[9],
          f = n[10],
          l = n[11],
          v = n[12],
          b = n[13],
          m = n[14],
          d = n[15],
          p = a * i - r * o,
          x = a * h - u * o,
          y = a * c - e * o,
          q = r * h - u * i,
          g = r * c - e * i,
          _ = u * c - e * h,
          A = s * b - M * v,
          w = s * m - f * v,
          z = s * d - l * v,
          R = M * m - f * b,
          O = M * d - l * b,
          j = f * d - l * m;
        return (
          (t[0] = i * j - h * O + c * R),
          (t[1] = u * O - r * j - e * R),
          (t[2] = b * _ - m * g + d * q),
          (t[3] = f * g - M * _ - l * q),
          (t[4] = h * z - o * j - c * w),
          (t[5] = a * j - u * z + e * w),
          (t[6] = m * y - v * _ - d * x),
          (t[7] = s * _ - f * y + l * x),
          (t[8] = o * O - i * z + c * A),
          (t[9] = r * z - a * O - e * A),
          (t[10] = v * g - b * y + d * p),
          (t[11] = M * y - s * g - l * p),
          (t[12] = i * w - o * R - h * A),
          (t[13] = a * R - r * w + u * A),
          (t[14] = b * x - v * q - m * p),
          (t[15] = s * q - M * x + f * p),
          t
        );
      },
      determinant: function (t) {
        var n = t[0],
          a = t[1],
          r = t[2],
          u = t[3],
          e = t[4],
          o = t[5],
          i = t[6],
          h = t[7],
          c = t[8],
          s = t[9],
          M = t[10],
          f = t[11],
          l = t[12],
          v = t[13],
          b = t[14],
          m = n * o - a * e,
          d = n * i - r * e,
          p = a * i - r * o,
          x = c * v - s * l,
          y = c * b - M * l,
          q = s * b - M * v;
        return (
          h * (n * q - a * y + r * x) -
          u * (e * q - o * y + i * x) +
          t[15] * (c * p - s * d + M * m) -
          f * (l * p - v * d + b * m)
        );
      },
      multiply: A,
      translate: function (t, n, a) {
        var r,
          u,
          e,
          o,
          i,
          h,
          c,
          s,
          M,
          f,
          l,
          v,
          b = a[0],
          m = a[1],
          d = a[2];
        return (
          n === t
            ? ((t[12] = n[0] * b + n[4] * m + n[8] * d + n[12]),
              (t[13] = n[1] * b + n[5] * m + n[9] * d + n[13]),
              (t[14] = n[2] * b + n[6] * m + n[10] * d + n[14]),
              (t[15] = n[3] * b + n[7] * m + n[11] * d + n[15]))
            : ((r = n[0]),
              (u = n[1]),
              (e = n[2]),
              (o = n[3]),
              (i = n[4]),
              (h = n[5]),
              (c = n[6]),
              (s = n[7]),
              (M = n[8]),
              (f = n[9]),
              (l = n[10]),
              (v = n[11]),
              (t[0] = r),
              (t[1] = u),
              (t[2] = e),
              (t[3] = o),
              (t[4] = i),
              (t[5] = h),
              (t[6] = c),
              (t[7] = s),
              (t[8] = M),
              (t[9] = f),
              (t[10] = l),
              (t[11] = v),
              (t[12] = r * b + i * m + M * d + n[12]),
              (t[13] = u * b + h * m + f * d + n[13]),
              (t[14] = e * b + c * m + l * d + n[14]),
              (t[15] = o * b + s * m + v * d + n[15])),
          t
        );
      },
      scale: function (t, n, a) {
        var r = a[0],
          u = a[1],
          e = a[2];
        return (
          (t[0] = n[0] * r),
          (t[1] = n[1] * r),
          (t[2] = n[2] * r),
          (t[3] = n[3] * r),
          (t[4] = n[4] * u),
          (t[5] = n[5] * u),
          (t[6] = n[6] * u),
          (t[7] = n[7] * u),
          (t[8] = n[8] * e),
          (t[9] = n[9] * e),
          (t[10] = n[10] * e),
          (t[11] = n[11] * e),
          (t[12] = n[12]),
          (t[13] = n[13]),
          (t[14] = n[14]),
          (t[15] = n[15]),
          t
        );
      },
      rotate: function (t, a, r, u) {
        var e,
          o,
          i,
          h,
          c,
          s,
          M,
          f,
          l,
          v,
          b,
          m,
          d,
          p,
          x,
          y,
          q,
          g,
          _,
          A,
          w,
          z,
          R,
          O,
          j = u[0],
          E = u[1],
          P = u[2],
          T = Math.hypot(j, E, P);
        return T < n
          ? null
          : ((j *= T = 1 / T),
            (E *= T),
            (P *= T),
            (e = Math.sin(r)),
            (i = 1 - (o = Math.cos(r))),
            (h = a[0]),
            (c = a[1]),
            (s = a[2]),
            (M = a[3]),
            (f = a[4]),
            (l = a[5]),
            (v = a[6]),
            (b = a[7]),
            (m = a[8]),
            (d = a[9]),
            (p = a[10]),
            (x = a[11]),
            (y = j * j * i + o),
            (q = E * j * i + P * e),
            (g = P * j * i - E * e),
            (_ = j * E * i - P * e),
            (A = E * E * i + o),
            (w = P * E * i + j * e),
            (z = j * P * i + E * e),
            (R = E * P * i - j * e),
            (O = P * P * i + o),
            (t[0] = h * y + f * q + m * g),
            (t[1] = c * y + l * q + d * g),
            (t[2] = s * y + v * q + p * g),
            (t[3] = M * y + b * q + x * g),
            (t[4] = h * _ + f * A + m * w),
            (t[5] = c * _ + l * A + d * w),
            (t[6] = s * _ + v * A + p * w),
            (t[7] = M * _ + b * A + x * w),
            (t[8] = h * z + f * R + m * O),
            (t[9] = c * z + l * R + d * O),
            (t[10] = s * z + v * R + p * O),
            (t[11] = M * z + b * R + x * O),
            a !== t &&
              ((t[12] = a[12]),
              (t[13] = a[13]),
              (t[14] = a[14]),
              (t[15] = a[15])),
            t);
      },
      rotateX: function (t, n, a) {
        var r = Math.sin(a),
          u = Math.cos(a),
          e = n[4],
          o = n[5],
          i = n[6],
          h = n[7],
          c = n[8],
          s = n[9],
          M = n[10],
          f = n[11];
        return (
          n !== t &&
            ((t[0] = n[0]),
            (t[1] = n[1]),
            (t[2] = n[2]),
            (t[3] = n[3]),
            (t[12] = n[12]),
            (t[13] = n[13]),
            (t[14] = n[14]),
            (t[15] = n[15])),
          (t[4] = e * u + c * r),
          (t[5] = o * u + s * r),
          (t[6] = i * u + M * r),
          (t[7] = h * u + f * r),
          (t[8] = c * u - e * r),
          (t[9] = s * u - o * r),
          (t[10] = M * u - i * r),
          (t[11] = f * u - h * r),
          t
        );
      },
      rotateY: function (t, n, a) {
        var r = Math.sin(a),
          u = Math.cos(a),
          e = n[0],
          o = n[1],
          i = n[2],
          h = n[3],
          c = n[8],
          s = n[9],
          M = n[10],
          f = n[11];
        return (
          n !== t &&
            ((t[4] = n[4]),
            (t[5] = n[5]),
            (t[6] = n[6]),
            (t[7] = n[7]),
            (t[12] = n[12]),
            (t[13] = n[13]),
            (t[14] = n[14]),
            (t[15] = n[15])),
          (t[0] = e * u - c * r),
          (t[1] = o * u - s * r),
          (t[2] = i * u - M * r),
          (t[3] = h * u - f * r),
          (t[8] = e * r + c * u),
          (t[9] = o * r + s * u),
          (t[10] = i * r + M * u),
          (t[11] = h * r + f * u),
          t
        );
      },
      rotateZ: function (t, n, a) {
        var r = Math.sin(a),
          u = Math.cos(a),
          e = n[0],
          o = n[1],
          i = n[2],
          h = n[3],
          c = n[4],
          s = n[5],
          M = n[6],
          f = n[7];
        return (
          n !== t &&
            ((t[8] = n[8]),
            (t[9] = n[9]),
            (t[10] = n[10]),
            (t[11] = n[11]),
            (t[12] = n[12]),
            (t[13] = n[13]),
            (t[14] = n[14]),
            (t[15] = n[15])),
          (t[0] = e * u + c * r),
          (t[1] = o * u + s * r),
          (t[2] = i * u + M * r),
          (t[3] = h * u + f * r),
          (t[4] = c * u - e * r),
          (t[5] = s * u - o * r),
          (t[6] = M * u - i * r),
          (t[7] = f * u - h * r),
          t
        );
      },
      fromTranslation: function (t, n) {
        return (
          (t[0] = 1),
          (t[1] = 0),
          (t[2] = 0),
          (t[3] = 0),
          (t[4] = 0),
          (t[5] = 1),
          (t[6] = 0),
          (t[7] = 0),
          (t[8] = 0),
          (t[9] = 0),
          (t[10] = 1),
          (t[11] = 0),
          (t[12] = n[0]),
          (t[13] = n[1]),
          (t[14] = n[2]),
          (t[15] = 1),
          t
        );
      },
      fromScaling: function (t, n) {
        return (
          (t[0] = n[0]),
          (t[1] = 0),
          (t[2] = 0),
          (t[3] = 0),
          (t[4] = 0),
          (t[5] = n[1]),
          (t[6] = 0),
          (t[7] = 0),
          (t[8] = 0),
          (t[9] = 0),
          (t[10] = n[2]),
          (t[11] = 0),
          (t[12] = 0),
          (t[13] = 0),
          (t[14] = 0),
          (t[15] = 1),
          t
        );
      },
      fromRotation: function (t, a, r) {
        var u,
          e,
          o,
          i = r[0],
          h = r[1],
          c = r[2],
          s = Math.hypot(i, h, c);
        return s < n
          ? null
          : ((i *= s = 1 / s),
            (h *= s),
            (c *= s),
            (u = Math.sin(a)),
            (o = 1 - (e = Math.cos(a))),
            (t[0] = i * i * o + e),
            (t[1] = h * i * o + c * u),
            (t[2] = c * i * o - h * u),
            (t[3] = 0),
            (t[4] = i * h * o - c * u),
            (t[5] = h * h * o + e),
            (t[6] = c * h * o + i * u),
            (t[7] = 0),
            (t[8] = i * c * o + h * u),
            (t[9] = h * c * o - i * u),
            (t[10] = c * c * o + e),
            (t[11] = 0),
            (t[12] = 0),
            (t[13] = 0),
            (t[14] = 0),
            (t[15] = 1),
            t);
      },
      fromXRotation: function (t, n) {
        var a = Math.sin(n),
          r = Math.cos(n);
        return (
          (t[0] = 1),
          (t[1] = 0),
          (t[2] = 0),
          (t[3] = 0),
          (t[4] = 0),
          (t[5] = r),
          (t[6] = a),
          (t[7] = 0),
          (t[8] = 0),
          (t[9] = -a),
          (t[10] = r),
          (t[11] = 0),
          (t[12] = 0),
          (t[13] = 0),
          (t[14] = 0),
          (t[15] = 1),
          t
        );
      },
      fromYRotation: function (t, n) {
        var a = Math.sin(n),
          r = Math.cos(n);
        return (
          (t[0] = r),
          (t[1] = 0),
          (t[2] = -a),
          (t[3] = 0),
          (t[4] = 0),
          (t[5] = 1),
          (t[6] = 0),
          (t[7] = 0),
          (t[8] = a),
          (t[9] = 0),
          (t[10] = r),
          (t[11] = 0),
          (t[12] = 0),
          (t[13] = 0),
          (t[14] = 0),
          (t[15] = 1),
          t
        );
      },
      fromZRotation: function (t, n) {
        var a = Math.sin(n),
          r = Math.cos(n);
        return (
          (t[0] = r),
          (t[1] = a),
          (t[2] = 0),
          (t[3] = 0),
          (t[4] = -a),
          (t[5] = r),
          (t[6] = 0),
          (t[7] = 0),
          (t[8] = 0),
          (t[9] = 0),
          (t[10] = 1),
          (t[11] = 0),
          (t[12] = 0),
          (t[13] = 0),
          (t[14] = 0),
          (t[15] = 1),
          t
        );
      },
      fromRotationTranslation: w,
      fromQuat2: function (t, n) {
        var r = new a(3),
          u = -n[0],
          e = -n[1],
          o = -n[2],
          i = n[3],
          h = n[4],
          c = n[5],
          s = n[6],
          M = n[7],
          f = u * u + e * e + o * o + i * i;
        return (
          f > 0
            ? ((r[0] = (2 * (h * i + M * u + c * o - s * e)) / f),
              (r[1] = (2 * (c * i + M * e + s * u - h * o)) / f),
              (r[2] = (2 * (s * i + M * o + h * e - c * u)) / f))
            : ((r[0] = 2 * (h * i + M * u + c * o - s * e)),
              (r[1] = 2 * (c * i + M * e + s * u - h * o)),
              (r[2] = 2 * (s * i + M * o + h * e - c * u))),
          w(t, n, r),
          t
        );
      },
      getTranslation: z,
      getScaling: R,
      getRotation: O,
      decompose: function (t, n, a, r) {
        (n[0] = r[12]), (n[1] = r[13]), (n[2] = r[14]);
        var u = r[0],
          e = r[1],
          o = r[2],
          i = r[4],
          h = r[5],
          c = r[6],
          s = r[8],
          M = r[9],
          f = r[10];
        (a[0] = Math.hypot(u, e, o)),
          (a[1] = Math.hypot(i, h, c)),
          (a[2] = Math.hypot(s, M, f));
        var l = 1 / a[0],
          v = 1 / a[1],
          b = 1 / a[2],
          m = u * l,
          d = e * v,
          p = o * b,
          x = i * l,
          y = h * v,
          q = c * b,
          g = s * l,
          _ = M * v,
          A = f * b,
          w = m + y + A,
          z = 0;
        return (
          w > 0
            ? ((z = 2 * Math.sqrt(w + 1)),
              (t[3] = 0.25 * z),
              (t[0] = (q - _) / z),
              (t[1] = (g - p) / z),
              (t[2] = (d - x) / z))
            : m > y && m > A
              ? ((z = 2 * Math.sqrt(1 + m - y - A)),
                (t[3] = (q - _) / z),
                (t[0] = 0.25 * z),
                (t[1] = (d + x) / z),
                (t[2] = (g + p) / z))
              : y > A
                ? ((z = 2 * Math.sqrt(1 + y - m - A)),
                  (t[3] = (g - p) / z),
                  (t[0] = (d + x) / z),
                  (t[1] = 0.25 * z),
                  (t[2] = (q + _) / z))
                : ((z = 2 * Math.sqrt(1 + A - m - y)),
                  (t[3] = (d - x) / z),
                  (t[0] = (g + p) / z),
                  (t[1] = (q + _) / z),
                  (t[2] = 0.25 * z)),
          t
        );
      },
      fromRotationTranslationScale: function (t, n, a, r) {
        var u = n[0],
          e = n[1],
          o = n[2],
          i = n[3],
          h = u + u,
          c = e + e,
          s = o + o,
          M = u * h,
          f = u * c,
          l = u * s,
          v = e * c,
          b = e * s,
          m = o * s,
          d = i * h,
          p = i * c,
          x = i * s,
          y = r[0],
          q = r[1],
          g = r[2];
        return (
          (t[0] = (1 - (v + m)) * y),
          (t[1] = (f + x) * y),
          (t[2] = (l - p) * y),
          (t[3] = 0),
          (t[4] = (f - x) * q),
          (t[5] = (1 - (M + m)) * q),
          (t[6] = (b + d) * q),
          (t[7] = 0),
          (t[8] = (l + p) * g),
          (t[9] = (b - d) * g),
          (t[10] = (1 - (M + v)) * g),
          (t[11] = 0),
          (t[12] = a[0]),
          (t[13] = a[1]),
          (t[14] = a[2]),
          (t[15] = 1),
          t
        );
      },
      fromRotationTranslationScaleOrigin: function (t, n, a, r, u) {
        var e = n[0],
          o = n[1],
          i = n[2],
          h = n[3],
          c = e + e,
          s = o + o,
          M = i + i,
          f = e * c,
          l = e * s,
          v = e * M,
          b = o * s,
          m = o * M,
          d = i * M,
          p = h * c,
          x = h * s,
          y = h * M,
          q = r[0],
          g = r[1],
          _ = r[2],
          A = u[0],
          w = u[1],
          z = u[2],
          R = (1 - (b + d)) * q,
          O = (l + y) * q,
          j = (v - x) * q,
          E = (l - y) * g,
          P = (1 - (f + d)) * g,
          T = (m + p) * g,
          S = (v + x) * _,
          D = (m - p) * _,
          F = (1 - (f + b)) * _;
        return (
          (t[0] = R),
          (t[1] = O),
          (t[2] = j),
          (t[3] = 0),
          (t[4] = E),
          (t[5] = P),
          (t[6] = T),
          (t[7] = 0),
          (t[8] = S),
          (t[9] = D),
          (t[10] = F),
          (t[11] = 0),
          (t[12] = a[0] + A - (R * A + E * w + S * z)),
          (t[13] = a[1] + w - (O * A + P * w + D * z)),
          (t[14] = a[2] + z - (j * A + T * w + F * z)),
          (t[15] = 1),
          t
        );
      },
      fromQuat: function (t, n) {
        var a = n[0],
          r = n[1],
          u = n[2],
          e = n[3],
          o = a + a,
          i = r + r,
          h = u + u,
          c = a * o,
          s = r * o,
          M = r * i,
          f = u * o,
          l = u * i,
          v = u * h,
          b = e * o,
          m = e * i,
          d = e * h;
        return (
          (t[0] = 1 - M - v),
          (t[1] = s + d),
          (t[2] = f - m),
          (t[3] = 0),
          (t[4] = s - d),
          (t[5] = 1 - c - v),
          (t[6] = l + b),
          (t[7] = 0),
          (t[8] = f + m),
          (t[9] = l - b),
          (t[10] = 1 - c - M),
          (t[11] = 0),
          (t[12] = 0),
          (t[13] = 0),
          (t[14] = 0),
          (t[15] = 1),
          t
        );
      },
      frustum: function (t, n, a, r, u, e, o) {
        var i = 1 / (a - n),
          h = 1 / (u - r),
          c = 1 / (e - o);
        return (
          (t[0] = 2 * e * i),
          (t[1] = 0),
          (t[2] = 0),
          (t[3] = 0),
          (t[4] = 0),
          (t[5] = 2 * e * h),
          (t[6] = 0),
          (t[7] = 0),
          (t[8] = (a + n) * i),
          (t[9] = (u + r) * h),
          (t[10] = (o + e) * c),
          (t[11] = -1),
          (t[12] = 0),
          (t[13] = 0),
          (t[14] = o * e * 2 * c),
          (t[15] = 0),
          t
        );
      },
      perspectiveNO: j,
      perspective: E,
      perspectiveZO: function (t, n, a, r, u) {
        var e = 1 / Math.tan(n / 2);
        if (
          ((t[0] = e / a),
          (t[1] = 0),
          (t[2] = 0),
          (t[3] = 0),
          (t[4] = 0),
          (t[5] = e),
          (t[6] = 0),
          (t[7] = 0),
          (t[8] = 0),
          (t[9] = 0),
          (t[11] = -1),
          (t[12] = 0),
          (t[13] = 0),
          (t[15] = 0),
          null != u && u !== 1 / 0)
        ) {
          var o = 1 / (r - u);
          (t[10] = u * o), (t[14] = u * r * o);
        } else (t[10] = -1), (t[14] = -r);
        return t;
      },
      perspectiveFromFieldOfView: function (t, n, a, r) {
        var u = Math.tan((n.upDegrees * Math.PI) / 180),
          e = Math.tan((n.downDegrees * Math.PI) / 180),
          o = Math.tan((n.leftDegrees * Math.PI) / 180),
          i = Math.tan((n.rightDegrees * Math.PI) / 180),
          h = 2 / (o + i),
          c = 2 / (u + e);
        return (
          (t[0] = h),
          (t[1] = 0),
          (t[2] = 0),
          (t[3] = 0),
          (t[4] = 0),
          (t[5] = c),
          (t[6] = 0),
          (t[7] = 0),
          (t[8] = -(o - i) * h * 0.5),
          (t[9] = (u - e) * c * 0.5),
          (t[10] = r / (a - r)),
          (t[11] = -1),
          (t[12] = 0),
          (t[13] = 0),
          (t[14] = (r * a) / (a - r)),
          (t[15] = 0),
          t
        );
      },
      orthoNO: P,
      ortho: T,
      orthoZO: function (t, n, a, r, u, e, o) {
        var i = 1 / (n - a),
          h = 1 / (r - u),
          c = 1 / (e - o);
        return (
          (t[0] = -2 * i),
          (t[1] = 0),
          (t[2] = 0),
          (t[3] = 0),
          (t[4] = 0),
          (t[5] = -2 * h),
          (t[6] = 0),
          (t[7] = 0),
          (t[8] = 0),
          (t[9] = 0),
          (t[10] = c),
          (t[11] = 0),
          (t[12] = (n + a) * i),
          (t[13] = (u + r) * h),
          (t[14] = e * c),
          (t[15] = 1),
          t
        );
      },
      lookAt: function (t, a, r, u) {
        var e,
          o,
          i,
          h,
          c,
          s,
          M,
          f,
          l,
          v,
          b = a[0],
          m = a[1],
          d = a[2],
          p = u[0],
          x = u[1],
          y = u[2],
          q = r[0],
          g = r[1],
          A = r[2];
        return Math.abs(b - q) < n && Math.abs(m - g) < n && Math.abs(d - A) < n
          ? _(t)
          : ((M = b - q),
            (f = m - g),
            (l = d - A),
            (e = x * (l *= v = 1 / Math.hypot(M, f, l)) - y * (f *= v)),
            (o = y * (M *= v) - p * l),
            (i = p * f - x * M),
            (v = Math.hypot(e, o, i))
              ? ((e *= v = 1 / v), (o *= v), (i *= v))
              : ((e = 0), (o = 0), (i = 0)),
            (h = f * i - l * o),
            (c = l * e - M * i),
            (s = M * o - f * e),
            (v = Math.hypot(h, c, s))
              ? ((h *= v = 1 / v), (c *= v), (s *= v))
              : ((h = 0), (c = 0), (s = 0)),
            (t[0] = e),
            (t[1] = h),
            (t[2] = M),
            (t[3] = 0),
            (t[4] = o),
            (t[5] = c),
            (t[6] = f),
            (t[7] = 0),
            (t[8] = i),
            (t[9] = s),
            (t[10] = l),
            (t[11] = 0),
            (t[12] = -(e * b + o * m + i * d)),
            (t[13] = -(h * b + c * m + s * d)),
            (t[14] = -(M * b + f * m + l * d)),
            (t[15] = 1),
            t);
      },
      targetTo: function (t, n, a, r) {
        var u = n[0],
          e = n[1],
          o = n[2],
          i = r[0],
          h = r[1],
          c = r[2],
          s = u - a[0],
          M = e - a[1],
          f = o - a[2],
          l = s * s + M * M + f * f;
        l > 0 && ((s *= l = 1 / Math.sqrt(l)), (M *= l), (f *= l));
        var v = h * f - c * M,
          b = c * s - i * f,
          m = i * M - h * s;
        return (
          (l = v * v + b * b + m * m) > 0 &&
            ((v *= l = 1 / Math.sqrt(l)), (b *= l), (m *= l)),
          (t[0] = v),
          (t[1] = b),
          (t[2] = m),
          (t[3] = 0),
          (t[4] = M * m - f * b),
          (t[5] = f * v - s * m),
          (t[6] = s * b - M * v),
          (t[7] = 0),
          (t[8] = s),
          (t[9] = M),
          (t[10] = f),
          (t[11] = 0),
          (t[12] = u),
          (t[13] = e),
          (t[14] = o),
          (t[15] = 1),
          t
        );
      },
      str: function (t) {
        return (
          "mat4(" +
          t[0] +
          ", " +
          t[1] +
          ", " +
          t[2] +
          ", " +
          t[3] +
          ", " +
          t[4] +
          ", " +
          t[5] +
          ", " +
          t[6] +
          ", " +
          t[7] +
          ", " +
          t[8] +
          ", " +
          t[9] +
          ", " +
          t[10] +
          ", " +
          t[11] +
          ", " +
          t[12] +
          ", " +
          t[13] +
          ", " +
          t[14] +
          ", " +
          t[15] +
          ")"
        );
      },
      frob: function (t) {
        return Math.hypot(
          t[0],
          t[1],
          t[2],
          t[3],
          t[4],
          t[5],
          t[6],
          t[7],
          t[8],
          t[9],
          t[10],
          t[11],
          t[12],
          t[13],
          t[14],
          t[15],
        );
      },
      add: function (t, n, a) {
        return (
          (t[0] = n[0] + a[0]),
          (t[1] = n[1] + a[1]),
          (t[2] = n[2] + a[2]),
          (t[3] = n[3] + a[3]),
          (t[4] = n[4] + a[4]),
          (t[5] = n[5] + a[5]),
          (t[6] = n[6] + a[6]),
          (t[7] = n[7] + a[7]),
          (t[8] = n[8] + a[8]),
          (t[9] = n[9] + a[9]),
          (t[10] = n[10] + a[10]),
          (t[11] = n[11] + a[11]),
          (t[12] = n[12] + a[12]),
          (t[13] = n[13] + a[13]),
          (t[14] = n[14] + a[14]),
          (t[15] = n[15] + a[15]),
          t
        );
      },
      subtract: S,
      multiplyScalar: function (t, n, a) {
        return (
          (t[0] = n[0] * a),
          (t[1] = n[1] * a),
          (t[2] = n[2] * a),
          (t[3] = n[3] * a),
          (t[4] = n[4] * a),
          (t[5] = n[5] * a),
          (t[6] = n[6] * a),
          (t[7] = n[7] * a),
          (t[8] = n[8] * a),
          (t[9] = n[9] * a),
          (t[10] = n[10] * a),
          (t[11] = n[11] * a),
          (t[12] = n[12] * a),
          (t[13] = n[13] * a),
          (t[14] = n[14] * a),
          (t[15] = n[15] * a),
          t
        );
      },
      multiplyScalarAndAdd: function (t, n, a, r) {
        return (
          (t[0] = n[0] + a[0] * r),
          (t[1] = n[1] + a[1] * r),
          (t[2] = n[2] + a[2] * r),
          (t[3] = n[3] + a[3] * r),
          (t[4] = n[4] + a[4] * r),
          (t[5] = n[5] + a[5] * r),
          (t[6] = n[6] + a[6] * r),
          (t[7] = n[7] + a[7] * r),
          (t[8] = n[8] + a[8] * r),
          (t[9] = n[9] + a[9] * r),
          (t[10] = n[10] + a[10] * r),
          (t[11] = n[11] + a[11] * r),
          (t[12] = n[12] + a[12] * r),
          (t[13] = n[13] + a[13] * r),
          (t[14] = n[14] + a[14] * r),
          (t[15] = n[15] + a[15] * r),
          t
        );
      },
      exactEquals: function (t, n) {
        return (
          t[0] === n[0] &&
          t[1] === n[1] &&
          t[2] === n[2] &&
          t[3] === n[3] &&
          t[4] === n[4] &&
          t[5] === n[5] &&
          t[6] === n[6] &&
          t[7] === n[7] &&
          t[8] === n[8] &&
          t[9] === n[9] &&
          t[10] === n[10] &&
          t[11] === n[11] &&
          t[12] === n[12] &&
          t[13] === n[13] &&
          t[14] === n[14] &&
          t[15] === n[15]
        );
      },
      equals: function (t, a) {
        var r = t[0],
          u = t[1],
          e = t[2],
          o = t[3],
          i = t[4],
          h = t[5],
          c = t[6],
          s = t[7],
          M = t[8],
          f = t[9],
          l = t[10],
          v = t[11],
          b = t[12],
          m = t[13],
          d = t[14],
          p = t[15],
          x = a[0],
          y = a[1],
          q = a[2],
          g = a[3],
          _ = a[4],
          A = a[5],
          w = a[6],
          z = a[7],
          R = a[8],
          O = a[9],
          j = a[10],
          E = a[11],
          P = a[12],
          T = a[13],
          S = a[14],
          D = a[15];
        return (
          Math.abs(r - x) <= n * Math.max(1, Math.abs(r), Math.abs(x)) &&
          Math.abs(u - y) <= n * Math.max(1, Math.abs(u), Math.abs(y)) &&
          Math.abs(e - q) <= n * Math.max(1, Math.abs(e), Math.abs(q)) &&
          Math.abs(o - g) <= n * Math.max(1, Math.abs(o), Math.abs(g)) &&
          Math.abs(i - _) <= n * Math.max(1, Math.abs(i), Math.abs(_)) &&
          Math.abs(h - A) <= n * Math.max(1, Math.abs(h), Math.abs(A)) &&
          Math.abs(c - w) <= n * Math.max(1, Math.abs(c), Math.abs(w)) &&
          Math.abs(s - z) <= n * Math.max(1, Math.abs(s), Math.abs(z)) &&
          Math.abs(M - R) <= n * Math.max(1, Math.abs(M), Math.abs(R)) &&
          Math.abs(f - O) <= n * Math.max(1, Math.abs(f), Math.abs(O)) &&
          Math.abs(l - j) <= n * Math.max(1, Math.abs(l), Math.abs(j)) &&
          Math.abs(v - E) <= n * Math.max(1, Math.abs(v), Math.abs(E)) &&
          Math.abs(b - P) <= n * Math.max(1, Math.abs(b), Math.abs(P)) &&
          Math.abs(m - T) <= n * Math.max(1, Math.abs(m), Math.abs(T)) &&
          Math.abs(d - S) <= n * Math.max(1, Math.abs(d), Math.abs(S)) &&
          Math.abs(p - D) <= n * Math.max(1, Math.abs(p), Math.abs(D))
        );
      },
      mul: D,
      sub: F,
    });
  function L() {
    var t = new a(3);
    return a != Float32Array && ((t[0] = 0), (t[1] = 0), (t[2] = 0)), t;
  }
  function V(t) {
    var n = t[0],
      a = t[1],
      r = t[2];
    return Math.hypot(n, a, r);
  }
  function k(t, n, r) {
    var u = new a(3);
    return (u[0] = t), (u[1] = n), (u[2] = r), u;
  }
  function Q(t, n, a) {
    return (t[0] = n[0] - a[0]), (t[1] = n[1] - a[1]), (t[2] = n[2] - a[2]), t;
  }
  function Y(t, n, a) {
    return (t[0] = n[0] * a[0]), (t[1] = n[1] * a[1]), (t[2] = n[2] * a[2]), t;
  }
  function Z(t, n, a) {
    return (t[0] = n[0] / a[0]), (t[1] = n[1] / a[1]), (t[2] = n[2] / a[2]), t;
  }
  function N(t, n) {
    var a = n[0] - t[0],
      r = n[1] - t[1],
      u = n[2] - t[2];
    return Math.hypot(a, r, u);
  }
  function X(t, n) {
    var a = n[0] - t[0],
      r = n[1] - t[1],
      u = n[2] - t[2];
    return a * a + r * r + u * u;
  }
  function B(t) {
    var n = t[0],
      a = t[1],
      r = t[2];
    return n * n + a * a + r * r;
  }
  function U(t, n) {
    var a = n[0],
      r = n[1],
      u = n[2],
      e = a * a + r * r + u * u;
    return (
      e > 0 && (e = 1 / Math.sqrt(e)),
      (t[0] = n[0] * e),
      (t[1] = n[1] * e),
      (t[2] = n[2] * e),
      t
    );
  }
  function G(t, n) {
    return t[0] * n[0] + t[1] * n[1] + t[2] * n[2];
  }
  function W(t, n, a) {
    var r = n[0],
      u = n[1],
      e = n[2],
      o = a[0],
      i = a[1],
      h = a[2];
    return (
      (t[0] = u * h - e * i), (t[1] = e * o - r * h), (t[2] = r * i - u * o), t
    );
  }
  var C,
    H = Q,
    J = Y,
    K = Z,
    $ = N,
    tt = X,
    nt = V,
    at = B,
    rt =
      ((C = L()),
      function (t, n, a, r, u, e) {
        var o, i;
        for (
          n || (n = 3),
            a || (a = 0),
            i = r ? Math.min(r * n + a, t.length) : t.length,
            o = a;
          o < i;
          o += n
        )
          (C[0] = t[o]),
            (C[1] = t[o + 1]),
            (C[2] = t[o + 2]),
            u(C, C, e),
            (t[o] = C[0]),
            (t[o + 1] = C[1]),
            (t[o + 2] = C[2]);
        return t;
      }),
    ut = Object.freeze({
      __proto__: null,
      create: L,
      clone: function (t) {
        var n = new a(3);
        return (n[0] = t[0]), (n[1] = t[1]), (n[2] = t[2]), n;
      },
      length: V,
      fromValues: k,
      copy: function (t, n) {
        return (t[0] = n[0]), (t[1] = n[1]), (t[2] = n[2]), t;
      },
      set: function (t, n, a, r) {
        return (t[0] = n), (t[1] = a), (t[2] = r), t;
      },
      add: function (t, n, a) {
        return (
          (t[0] = n[0] + a[0]), (t[1] = n[1] + a[1]), (t[2] = n[2] + a[2]), t
        );
      },
      subtract: Q,
      multiply: Y,
      divide: Z,
      ceil: function (t, n) {
        return (
          (t[0] = Math.ceil(n[0])),
          (t[1] = Math.ceil(n[1])),
          (t[2] = Math.ceil(n[2])),
          t
        );
      },
      floor: function (t, n) {
        return (
          (t[0] = Math.floor(n[0])),
          (t[1] = Math.floor(n[1])),
          (t[2] = Math.floor(n[2])),
          t
        );
      },
      min: function (t, n, a) {
        return (
          (t[0] = Math.min(n[0], a[0])),
          (t[1] = Math.min(n[1], a[1])),
          (t[2] = Math.min(n[2], a[2])),
          t
        );
      },
      max: function (t, n, a) {
        return (
          (t[0] = Math.max(n[0], a[0])),
          (t[1] = Math.max(n[1], a[1])),
          (t[2] = Math.max(n[2], a[2])),
          t
        );
      },
      round: function (t, n) {
        return (
          (t[0] = Math.round(n[0])),
          (t[1] = Math.round(n[1])),
          (t[2] = Math.round(n[2])),
          t
        );
      },
      scale: function (t, n, a) {
        return (t[0] = n[0] * a), (t[1] = n[1] * a), (t[2] = n[2] * a), t;
      },
      scaleAndAdd: function (t, n, a, r) {
        return (
          (t[0] = n[0] + a[0] * r),
          (t[1] = n[1] + a[1] * r),
          (t[2] = n[2] + a[2] * r),
          t
        );
      },
      distance: N,
      squaredDistance: X,
      squaredLength: B,
      negate: function (t, n) {
        return (t[0] = -n[0]), (t[1] = -n[1]), (t[2] = -n[2]), t;
      },
      inverse: function (t, n) {
        return (t[0] = 1 / n[0]), (t[1] = 1 / n[1]), (t[2] = 1 / n[2]), t;
      },
      normalize: U,
      dot: G,
      cross: W,
      lerp: function (t, n, a, r) {
        var u = n[0],
          e = n[1],
          o = n[2];
        return (
          (t[0] = u + r * (a[0] - u)),
          (t[1] = e + r * (a[1] - e)),
          (t[2] = o + r * (a[2] - o)),
          t
        );
      },
      slerp: function (t, n, a, r) {
        var u = Math.acos(Math.min(Math.max(G(n, a), -1), 1)),
          e = Math.sin(u),
          o = Math.sin((1 - r) * u) / e,
          i = Math.sin(r * u) / e;
        return (
          (t[0] = o * n[0] + i * a[0]),
          (t[1] = o * n[1] + i * a[1]),
          (t[2] = o * n[2] + i * a[2]),
          t
        );
      },
      hermite: function (t, n, a, r, u, e) {
        var o = e * e,
          i = o * (2 * e - 3) + 1,
          h = o * (e - 2) + e,
          c = o * (e - 1),
          s = o * (3 - 2 * e);
        return (
          (t[0] = n[0] * i + a[0] * h + r[0] * c + u[0] * s),
          (t[1] = n[1] * i + a[1] * h + r[1] * c + u[1] * s),
          (t[2] = n[2] * i + a[2] * h + r[2] * c + u[2] * s),
          t
        );
      },
      bezier: function (t, n, a, r, u, e) {
        var o = 1 - e,
          i = o * o,
          h = e * e,
          c = i * o,
          s = 3 * e * i,
          M = 3 * h * o,
          f = h * e;
        return (
          (t[0] = n[0] * c + a[0] * s + r[0] * M + u[0] * f),
          (t[1] = n[1] * c + a[1] * s + r[1] * M + u[1] * f),
          (t[2] = n[2] * c + a[2] * s + r[2] * M + u[2] * f),
          t
        );
      },
      random: function (t, n) {
        n = void 0 === n ? 1 : n;
        var a = 2 * r() * Math.PI,
          u = 2 * r() - 1,
          e = Math.sqrt(1 - u * u) * n;
        return (
          (t[0] = Math.cos(a) * e), (t[1] = Math.sin(a) * e), (t[2] = u * n), t
        );
      },
      transformMat4: function (t, n, a) {
        var r = n[0],
          u = n[1],
          e = n[2],
          o = a[3] * r + a[7] * u + a[11] * e + a[15];
        return (
          (o = o || 1),
          (t[0] = (a[0] * r + a[4] * u + a[8] * e + a[12]) / o),
          (t[1] = (a[1] * r + a[5] * u + a[9] * e + a[13]) / o),
          (t[2] = (a[2] * r + a[6] * u + a[10] * e + a[14]) / o),
          t
        );
      },
      transformMat3: function (t, n, a) {
        var r = n[0],
          u = n[1],
          e = n[2];
        return (
          (t[0] = r * a[0] + u * a[3] + e * a[6]),
          (t[1] = r * a[1] + u * a[4] + e * a[7]),
          (t[2] = r * a[2] + u * a[5] + e * a[8]),
          t
        );
      },
      transformQuat: function (t, n, a) {
        var r = a[0],
          u = a[1],
          e = a[2],
          o = a[3],
          i = n[0],
          h = n[1],
          c = n[2],
          s = u * c - e * h,
          M = e * i - r * c,
          f = r * h - u * i,
          l = u * f - e * M,
          v = e * s - r * f,
          b = r * M - u * s,
          m = 2 * o;
        return (
          (s *= m),
          (M *= m),
          (f *= m),
          (l *= 2),
          (v *= 2),
          (b *= 2),
          (t[0] = i + s + l),
          (t[1] = h + M + v),
          (t[2] = c + f + b),
          t
        );
      },
      rotateX: function (t, n, a, r) {
        var u = [],
          e = [];
        return (
          (u[0] = n[0] - a[0]),
          (u[1] = n[1] - a[1]),
          (u[2] = n[2] - a[2]),
          (e[0] = u[0]),
          (e[1] = u[1] * Math.cos(r) - u[2] * Math.sin(r)),
          (e[2] = u[1] * Math.sin(r) + u[2] * Math.cos(r)),
          (t[0] = e[0] + a[0]),
          (t[1] = e[1] + a[1]),
          (t[2] = e[2] + a[2]),
          t
        );
      },
      rotateY: function (t, n, a, r) {
        var u = [],
          e = [];
        return (
          (u[0] = n[0] - a[0]),
          (u[1] = n[1] - a[1]),
          (u[2] = n[2] - a[2]),
          (e[0] = u[2] * Math.sin(r) + u[0] * Math.cos(r)),
          (e[1] = u[1]),
          (e[2] = u[2] * Math.cos(r) - u[0] * Math.sin(r)),
          (t[0] = e[0] + a[0]),
          (t[1] = e[1] + a[1]),
          (t[2] = e[2] + a[2]),
          t
        );
      },
      rotateZ: function (t, n, a, r) {
        var u = [],
          e = [];
        return (
          (u[0] = n[0] - a[0]),
          (u[1] = n[1] - a[1]),
          (u[2] = n[2] - a[2]),
          (e[0] = u[0] * Math.cos(r) - u[1] * Math.sin(r)),
          (e[1] = u[0] * Math.sin(r) + u[1] * Math.cos(r)),
          (e[2] = u[2]),
          (t[0] = e[0] + a[0]),
          (t[1] = e[1] + a[1]),
          (t[2] = e[2] + a[2]),
          t
        );
      },
      angle: function (t, n) {
        var a = t[0],
          r = t[1],
          u = t[2],
          e = n[0],
          o = n[1],
          i = n[2],
          h = Math.sqrt((a * a + r * r + u * u) * (e * e + o * o + i * i)),
          c = h && G(t, n) / h;
        return Math.acos(Math.min(Math.max(c, -1), 1));
      },
      zero: function (t) {
        return (t[0] = 0), (t[1] = 0), (t[2] = 0), t;
      },
      str: function (t) {
        return "vec3(" + t[0] + ", " + t[1] + ", " + t[2] + ")";
      },
      exactEquals: function (t, n) {
        return t[0] === n[0] && t[1] === n[1] && t[2] === n[2];
      },
      equals: function (t, a) {
        var r = t[0],
          u = t[1],
          e = t[2],
          o = a[0],
          i = a[1],
          h = a[2];
        return (
          Math.abs(r - o) <= n * Math.max(1, Math.abs(r), Math.abs(o)) &&
          Math.abs(u - i) <= n * Math.max(1, Math.abs(u), Math.abs(i)) &&
          Math.abs(e - h) <= n * Math.max(1, Math.abs(e), Math.abs(h))
        );
      },
      sub: H,
      mul: J,
      div: K,
      dist: $,
      sqrDist: tt,
      len: nt,
      sqrLen: at,
      forEach: rt,
    });
  function et() {
    var t = new a(4);
    return (
      a != Float32Array && ((t[0] = 0), (t[1] = 0), (t[2] = 0), (t[3] = 0)), t
    );
  }
  function ot(t) {
    var n = new a(4);
    return (n[0] = t[0]), (n[1] = t[1]), (n[2] = t[2]), (n[3] = t[3]), n;
  }
  function it(t, n, r, u) {
    var e = new a(4);
    return (e[0] = t), (e[1] = n), (e[2] = r), (e[3] = u), e;
  }
  function ht(t, n) {
    return (t[0] = n[0]), (t[1] = n[1]), (t[2] = n[2]), (t[3] = n[3]), t;
  }
  function ct(t, n, a, r, u) {
    return (t[0] = n), (t[1] = a), (t[2] = r), (t[3] = u), t;
  }
  function st(t, n, a) {
    return (
      (t[0] = n[0] + a[0]),
      (t[1] = n[1] + a[1]),
      (t[2] = n[2] + a[2]),
      (t[3] = n[3] + a[3]),
      t
    );
  }
  function Mt(t, n, a) {
    return (
      (t[0] = n[0] - a[0]),
      (t[1] = n[1] - a[1]),
      (t[2] = n[2] - a[2]),
      (t[3] = n[3] - a[3]),
      t
    );
  }
  function ft(t, n, a) {
    return (
      (t[0] = n[0] * a[0]),
      (t[1] = n[1] * a[1]),
      (t[2] = n[2] * a[2]),
      (t[3] = n[3] * a[3]),
      t
    );
  }
  function lt(t, n, a) {
    return (
      (t[0] = n[0] / a[0]),
      (t[1] = n[1] / a[1]),
      (t[2] = n[2] / a[2]),
      (t[3] = n[3] / a[3]),
      t
    );
  }
  function vt(t, n, a) {
    return (
      (t[0] = n[0] * a),
      (t[1] = n[1] * a),
      (t[2] = n[2] * a),
      (t[3] = n[3] * a),
      t
    );
  }
  function bt(t, n) {
    var a = n[0] - t[0],
      r = n[1] - t[1],
      u = n[2] - t[2],
      e = n[3] - t[3];
    return Math.hypot(a, r, u, e);
  }
  function mt(t, n) {
    var a = n[0] - t[0],
      r = n[1] - t[1],
      u = n[2] - t[2],
      e = n[3] - t[3];
    return a * a + r * r + u * u + e * e;
  }
  function dt(t) {
    var n = t[0],
      a = t[1],
      r = t[2],
      u = t[3];
    return Math.hypot(n, a, r, u);
  }
  function pt(t) {
    var n = t[0],
      a = t[1],
      r = t[2],
      u = t[3];
    return n * n + a * a + r * r + u * u;
  }
  function xt(t, n) {
    var a = n[0],
      r = n[1],
      u = n[2],
      e = n[3],
      o = a * a + r * r + u * u + e * e;
    return (
      o > 0 && (o = 1 / Math.sqrt(o)),
      (t[0] = a * o),
      (t[1] = r * o),
      (t[2] = u * o),
      (t[3] = e * o),
      t
    );
  }
  function yt(t, n) {
    return t[0] * n[0] + t[1] * n[1] + t[2] * n[2] + t[3] * n[3];
  }
  function qt(t, n, a, r) {
    var u = n[0],
      e = n[1],
      o = n[2],
      i = n[3];
    return (
      (t[0] = u + r * (a[0] - u)),
      (t[1] = e + r * (a[1] - e)),
      (t[2] = o + r * (a[2] - o)),
      (t[3] = i + r * (a[3] - i)),
      t
    );
  }
  function gt(t, n) {
    return t[0] === n[0] && t[1] === n[1] && t[2] === n[2] && t[3] === n[3];
  }
  var _t = Mt,
    At = ft,
    wt = lt,
    zt = bt,
    Rt = mt,
    Ot = dt,
    jt = pt,
    Et = (function () {
      var t = et();
      return function (n, a, r, u, e, o) {
        var i, h;
        for (
          a || (a = 4),
            r || (r = 0),
            h = u ? Math.min(u * a + r, n.length) : n.length,
            i = r;
          i < h;
          i += a
        )
          (t[0] = n[i]),
            (t[1] = n[i + 1]),
            (t[2] = n[i + 2]),
            (t[3] = n[i + 3]),
            e(t, t, o),
            (n[i] = t[0]),
            (n[i + 1] = t[1]),
            (n[i + 2] = t[2]),
            (n[i + 3] = t[3]);
        return n;
      };
    })(),
    Pt = Object.freeze({
      __proto__: null,
      create: et,
      clone: ot,
      fromValues: it,
      copy: ht,
      set: ct,
      add: st,
      subtract: Mt,
      multiply: ft,
      divide: lt,
      ceil: function (t, n) {
        return (
          (t[0] = Math.ceil(n[0])),
          (t[1] = Math.ceil(n[1])),
          (t[2] = Math.ceil(n[2])),
          (t[3] = Math.ceil(n[3])),
          t
        );
      },
      floor: function (t, n) {
        return (
          (t[0] = Math.floor(n[0])),
          (t[1] = Math.floor(n[1])),
          (t[2] = Math.floor(n[2])),
          (t[3] = Math.floor(n[3])),
          t
        );
      },
      min: function (t, n, a) {
        return (
          (t[0] = Math.min(n[0], a[0])),
          (t[1] = Math.min(n[1], a[1])),
          (t[2] = Math.min(n[2], a[2])),
          (t[3] = Math.min(n[3], a[3])),
          t
        );
      },
      max: function (t, n, a) {
        return (
          (t[0] = Math.max(n[0], a[0])),
          (t[1] = Math.max(n[1], a[1])),
          (t[2] = Math.max(n[2], a[2])),
          (t[3] = Math.max(n[3], a[3])),
          t
        );
      },
      round: function (t, n) {
        return (
          (t[0] = Math.round(n[0])),
          (t[1] = Math.round(n[1])),
          (t[2] = Math.round(n[2])),
          (t[3] = Math.round(n[3])),
          t
        );
      },
      scale: vt,
      scaleAndAdd: function (t, n, a, r) {
        return (
          (t[0] = n[0] + a[0] * r),
          (t[1] = n[1] + a[1] * r),
          (t[2] = n[2] + a[2] * r),
          (t[3] = n[3] + a[3] * r),
          t
        );
      },
      distance: bt,
      squaredDistance: mt,
      length: dt,
      squaredLength: pt,
      negate: function (t, n) {
        return (
          (t[0] = -n[0]), (t[1] = -n[1]), (t[2] = -n[2]), (t[3] = -n[3]), t
        );
      },
      inverse: function (t, n) {
        return (
          (t[0] = 1 / n[0]),
          (t[1] = 1 / n[1]),
          (t[2] = 1 / n[2]),
          (t[3] = 1 / n[3]),
          t
        );
      },
      normalize: xt,
      dot: yt,
      cross: function (t, n, a, r) {
        var u = a[0] * r[1] - a[1] * r[0],
          e = a[0] * r[2] - a[2] * r[0],
          o = a[0] * r[3] - a[3] * r[0],
          i = a[1] * r[2] - a[2] * r[1],
          h = a[1] * r[3] - a[3] * r[1],
          c = a[2] * r[3] - a[3] * r[2],
          s = n[0],
          M = n[1],
          f = n[2],
          l = n[3];
        return (
          (t[0] = M * c - f * h + l * i),
          (t[1] = -s * c + f * o - l * e),
          (t[2] = s * h - M * o + l * u),
          (t[3] = -s * i + M * e - f * u),
          t
        );
      },
      lerp: qt,
      random: function (t, n) {
        var a, u, e, o, i, h;
        n = void 0 === n ? 1 : n;
        do {
          i = (a = 2 * r() - 1) * a + (u = 2 * r() - 1) * u;
        } while (i >= 1);
        do {
          h = (e = 2 * r() - 1) * e + (o = 2 * r() - 1) * o;
        } while (h >= 1);
        var c = Math.sqrt((1 - i) / h);
        return (
          (t[0] = n * a),
          (t[1] = n * u),
          (t[2] = n * e * c),
          (t[3] = n * o * c),
          t
        );
      },
      transformMat4: function (t, n, a) {
        var r = n[0],
          u = n[1],
          e = n[2],
          o = n[3];
        return (
          (t[0] = a[0] * r + a[4] * u + a[8] * e + a[12] * o),
          (t[1] = a[1] * r + a[5] * u + a[9] * e + a[13] * o),
          (t[2] = a[2] * r + a[6] * u + a[10] * e + a[14] * o),
          (t[3] = a[3] * r + a[7] * u + a[11] * e + a[15] * o),
          t
        );
      },
      transformQuat: function (t, n, a) {
        var r = n[0],
          u = n[1],
          e = n[2],
          o = a[0],
          i = a[1],
          h = a[2],
          c = a[3],
          s = c * r + i * e - h * u,
          M = c * u + h * r - o * e,
          f = c * e + o * u - i * r,
          l = -o * r - i * u - h * e;
        return (
          (t[0] = s * c + l * -o + M * -h - f * -i),
          (t[1] = M * c + l * -i + f * -o - s * -h),
          (t[2] = f * c + l * -h + s * -i - M * -o),
          (t[3] = n[3]),
          t
        );
      },
      zero: function (t) {
        return (t[0] = 0), (t[1] = 0), (t[2] = 0), (t[3] = 0), t;
      },
      str: function (t) {
        return "vec4(" + t[0] + ", " + t[1] + ", " + t[2] + ", " + t[3] + ")";
      },
      exactEquals: gt,
      equals: function (t, a) {
        var r = t[0],
          u = t[1],
          e = t[2],
          o = t[3],
          i = a[0],
          h = a[1],
          c = a[2],
          s = a[3];
        return (
          Math.abs(r - i) <= n * Math.max(1, Math.abs(r), Math.abs(i)) &&
          Math.abs(u - h) <= n * Math.max(1, Math.abs(u), Math.abs(h)) &&
          Math.abs(e - c) <= n * Math.max(1, Math.abs(e), Math.abs(c)) &&
          Math.abs(o - s) <= n * Math.max(1, Math.abs(o), Math.abs(s))
        );
      },
      sub: _t,
      mul: At,
      div: wt,
      dist: zt,
      sqrDist: Rt,
      len: Ot,
      sqrLen: jt,
      forEach: Et,
    });
  function Tt() {
    var t = new a(4);
    return (
      a != Float32Array && ((t[0] = 0), (t[1] = 0), (t[2] = 0)), (t[3] = 1), t
    );
  }
  function St(t, n, a) {
    a *= 0.5;
    var r = Math.sin(a);
    return (
      (t[0] = r * n[0]),
      (t[1] = r * n[1]),
      (t[2] = r * n[2]),
      (t[3] = Math.cos(a)),
      t
    );
  }
  function Dt(t, n, a) {
    var r = n[0],
      u = n[1],
      e = n[2],
      o = n[3],
      i = a[0],
      h = a[1],
      c = a[2],
      s = a[3];
    return (
      (t[0] = r * s + o * i + u * c - e * h),
      (t[1] = u * s + o * h + e * i - r * c),
      (t[2] = e * s + o * c + r * h - u * i),
      (t[3] = o * s - r * i - u * h - e * c),
      t
    );
  }
  function Ft(t, n, a) {
    a *= 0.5;
    var r = n[0],
      u = n[1],
      e = n[2],
      o = n[3],
      i = Math.sin(a),
      h = Math.cos(a);
    return (
      (t[0] = r * h + o * i),
      (t[1] = u * h + e * i),
      (t[2] = e * h - u * i),
      (t[3] = o * h - r * i),
      t
    );
  }
  function It(t, n, a) {
    a *= 0.5;
    var r = n[0],
      u = n[1],
      e = n[2],
      o = n[3],
      i = Math.sin(a),
      h = Math.cos(a);
    return (
      (t[0] = r * h - e * i),
      (t[1] = u * h + o * i),
      (t[2] = e * h + r * i),
      (t[3] = o * h - u * i),
      t
    );
  }
  function Lt(t, n, a) {
    a *= 0.5;
    var r = n[0],
      u = n[1],
      e = n[2],
      o = n[3],
      i = Math.sin(a),
      h = Math.cos(a);
    return (
      (t[0] = r * h + u * i),
      (t[1] = u * h - r * i),
      (t[2] = e * h + o * i),
      (t[3] = o * h - e * i),
      t
    );
  }
  function Vt(t, n) {
    var a = n[0],
      r = n[1],
      u = n[2],
      e = n[3],
      o = Math.sqrt(a * a + r * r + u * u),
      i = Math.exp(e),
      h = o > 0 ? (i * Math.sin(o)) / o : 0;
    return (
      (t[0] = a * h),
      (t[1] = r * h),
      (t[2] = u * h),
      (t[3] = i * Math.cos(o)),
      t
    );
  }
  function kt(t, n) {
    var a = n[0],
      r = n[1],
      u = n[2],
      e = n[3],
      o = Math.sqrt(a * a + r * r + u * u),
      i = o > 0 ? Math.atan2(o, e) / o : 0;
    return (
      (t[0] = a * i),
      (t[1] = r * i),
      (t[2] = u * i),
      (t[3] = 0.5 * Math.log(a * a + r * r + u * u + e * e)),
      t
    );
  }
  function Qt(t, a, r, u) {
    var e,
      o,
      i,
      h,
      c,
      s = a[0],
      M = a[1],
      f = a[2],
      l = a[3],
      v = r[0],
      b = r[1],
      m = r[2],
      d = r[3];
    return (
      (o = s * v + M * b + f * m + l * d) < 0 &&
        ((o = -o), (v = -v), (b = -b), (m = -m), (d = -d)),
      1 - o > n
        ? ((e = Math.acos(o)),
          (i = Math.sin(e)),
          (h = Math.sin((1 - u) * e) / i),
          (c = Math.sin(u * e) / i))
        : ((h = 1 - u), (c = u)),
      (t[0] = h * s + c * v),
      (t[1] = h * M + c * b),
      (t[2] = h * f + c * m),
      (t[3] = h * l + c * d),
      t
    );
  }
  function Yt(t, n) {
    var a,
      r = n[0] + n[4] + n[8];
    if (r > 0)
      (a = Math.sqrt(r + 1)),
        (t[3] = 0.5 * a),
        (a = 0.5 / a),
        (t[0] = (n[5] - n[7]) * a),
        (t[1] = (n[6] - n[2]) * a),
        (t[2] = (n[1] - n[3]) * a);
    else {
      var u = 0;
      n[4] > n[0] && (u = 1), n[8] > n[3 * u + u] && (u = 2);
      var e = (u + 1) % 3,
        o = (u + 2) % 3;
      (a = Math.sqrt(n[3 * u + u] - n[3 * e + e] - n[3 * o + o] + 1)),
        (t[u] = 0.5 * a),
        (a = 0.5 / a),
        (t[3] = (n[3 * e + o] - n[3 * o + e]) * a),
        (t[e] = (n[3 * e + u] + n[3 * u + e]) * a),
        (t[o] = (n[3 * o + u] + n[3 * u + o]) * a);
    }
    return t;
  }
  var Zt = ot,
    Nt = it,
    Xt = ht,
    Bt = ct,
    Ut = st,
    Gt = Dt,
    Wt = vt,
    Ct = yt,
    Ht = qt,
    Jt = dt,
    Kt = Jt,
    $t = pt,
    tn = $t,
    nn = xt,
    an = gt;
  var rn,
    un,
    en,
    on,
    hn,
    cn,
    sn =
      ((rn = L()),
      (un = k(1, 0, 0)),
      (en = k(0, 1, 0)),
      function (t, n, a) {
        var r = G(n, a);
        return r < -0.999999
          ? (W(rn, un, n),
            nt(rn) < 1e-6 && W(rn, en, n),
            U(rn, rn),
            St(t, rn, Math.PI),
            t)
          : r > 0.999999
            ? ((t[0] = 0), (t[1] = 0), (t[2] = 0), (t[3] = 1), t)
            : (W(rn, n, a),
              (t[0] = rn[0]),
              (t[1] = rn[1]),
              (t[2] = rn[2]),
              (t[3] = 1 + r),
              nn(t, t));
      }),
    Mn =
      ((on = Tt()),
      (hn = Tt()),
      function (t, n, a, r, u, e) {
        return (
          Qt(on, n, u, e), Qt(hn, a, r, e), Qt(t, on, hn, 2 * e * (1 - e)), t
        );
      }),
    fn =
      ((cn = d()),
      function (t, n, a, r) {
        return (
          (cn[0] = a[0]),
          (cn[3] = a[1]),
          (cn[6] = a[2]),
          (cn[1] = r[0]),
          (cn[4] = r[1]),
          (cn[7] = r[2]),
          (cn[2] = -n[0]),
          (cn[5] = -n[1]),
          (cn[8] = -n[2]),
          nn(t, Yt(t, cn))
        );
      }),
    ln = Object.freeze({
      __proto__: null,
      create: Tt,
      identity: function (t) {
        return (t[0] = 0), (t[1] = 0), (t[2] = 0), (t[3] = 1), t;
      },
      setAxisAngle: St,
      getAxisAngle: function (t, a) {
        var r = 2 * Math.acos(a[3]),
          u = Math.sin(r / 2);
        return (
          u > n
            ? ((t[0] = a[0] / u), (t[1] = a[1] / u), (t[2] = a[2] / u))
            : ((t[0] = 1), (t[1] = 0), (t[2] = 0)),
          r
        );
      },
      getAngle: function (t, n) {
        var a = Ct(t, n);
        return Math.acos(2 * a * a - 1);
      },
      multiply: Dt,
      rotateX: Ft,
      rotateY: It,
      rotateZ: Lt,
      calculateW: function (t, n) {
        var a = n[0],
          r = n[1],
          u = n[2];
        return (
          (t[0] = a),
          (t[1] = r),
          (t[2] = u),
          (t[3] = Math.sqrt(Math.abs(1 - a * a - r * r - u * u))),
          t
        );
      },
      exp: Vt,
      ln: kt,
      pow: function (t, n, a) {
        return kt(t, n), Wt(t, t, a), Vt(t, t), t;
      },
      slerp: Qt,
      random: function (t) {
        var n = r(),
          a = r(),
          u = r(),
          e = Math.sqrt(1 - n),
          o = Math.sqrt(n);
        return (
          (t[0] = e * Math.sin(2 * Math.PI * a)),
          (t[1] = e * Math.cos(2 * Math.PI * a)),
          (t[2] = o * Math.sin(2 * Math.PI * u)),
          (t[3] = o * Math.cos(2 * Math.PI * u)),
          t
        );
      },
      invert: function (t, n) {
        var a = n[0],
          r = n[1],
          u = n[2],
          e = n[3],
          o = a * a + r * r + u * u + e * e,
          i = o ? 1 / o : 0;
        return (
          (t[0] = -a * i), (t[1] = -r * i), (t[2] = -u * i), (t[3] = e * i), t
        );
      },
      conjugate: function (t, n) {
        return (t[0] = -n[0]), (t[1] = -n[1]), (t[2] = -n[2]), (t[3] = n[3]), t;
      },
      fromMat3: Yt,
      fromEuler: function (t, n, a, r) {
        var e =
            arguments.length > 4 && void 0 !== arguments[4] ? arguments[4] : u,
          o = Math.PI / 360;
        (n *= o), (r *= o), (a *= o);
        var i = Math.sin(n),
          h = Math.cos(n),
          c = Math.sin(a),
          s = Math.cos(a),
          M = Math.sin(r),
          f = Math.cos(r);
        switch (e) {
          case "xyz":
            (t[0] = i * s * f + h * c * M),
              (t[1] = h * c * f - i * s * M),
              (t[2] = h * s * M + i * c * f),
              (t[3] = h * s * f - i * c * M);
            break;
          case "xzy":
            (t[0] = i * s * f - h * c * M),
              (t[1] = h * c * f - i * s * M),
              (t[2] = h * s * M + i * c * f),
              (t[3] = h * s * f + i * c * M);
            break;
          case "yxz":
            (t[0] = i * s * f + h * c * M),
              (t[1] = h * c * f - i * s * M),
              (t[2] = h * s * M - i * c * f),
              (t[3] = h * s * f + i * c * M);
            break;
          case "yzx":
            (t[0] = i * s * f + h * c * M),
              (t[1] = h * c * f + i * s * M),
              (t[2] = h * s * M - i * c * f),
              (t[3] = h * s * f - i * c * M);
            break;
          case "zxy":
            (t[0] = i * s * f - h * c * M),
              (t[1] = h * c * f + i * s * M),
              (t[2] = h * s * M + i * c * f),
              (t[3] = h * s * f - i * c * M);
            break;
          case "zyx":
            (t[0] = i * s * f - h * c * M),
              (t[1] = h * c * f + i * s * M),
              (t[2] = h * s * M - i * c * f),
              (t[3] = h * s * f + i * c * M);
            break;
          default:
            throw new Error("Unknown angle order " + e);
        }
        return t;
      },
      str: function (t) {
        return "quat(" + t[0] + ", " + t[1] + ", " + t[2] + ", " + t[3] + ")";
      },
      clone: Zt,
      fromValues: Nt,
      copy: Xt,
      set: Bt,
      add: Ut,
      mul: Gt,
      scale: Wt,
      dot: Ct,
      lerp: Ht,
      length: Jt,
      len: Kt,
      squaredLength: $t,
      sqrLen: tn,
      normalize: nn,
      exactEquals: an,
      equals: function (t, n) {
        return Math.abs(yt(t, n)) >= 0.999999;
      },
      rotationTo: sn,
      sqlerp: Mn,
      setAxes: fn,
    });
  function vn(t, n, a) {
    var r = 0.5 * a[0],
      u = 0.5 * a[1],
      e = 0.5 * a[2],
      o = n[0],
      i = n[1],
      h = n[2],
      c = n[3];
    return (
      (t[0] = o),
      (t[1] = i),
      (t[2] = h),
      (t[3] = c),
      (t[4] = r * c + u * h - e * i),
      (t[5] = u * c + e * o - r * h),
      (t[6] = e * c + r * i - u * o),
      (t[7] = -r * o - u * i - e * h),
      t
    );
  }
  function bn(t, n) {
    return (
      (t[0] = n[0]),
      (t[1] = n[1]),
      (t[2] = n[2]),
      (t[3] = n[3]),
      (t[4] = n[4]),
      (t[5] = n[5]),
      (t[6] = n[6]),
      (t[7] = n[7]),
      t
    );
  }
  var mn = Xt;
  var dn = Xt;
  function pn(t, n, a) {
    var r = n[0],
      u = n[1],
      e = n[2],
      o = n[3],
      i = a[4],
      h = a[5],
      c = a[6],
      s = a[7],
      M = n[4],
      f = n[5],
      l = n[6],
      v = n[7],
      b = a[0],
      m = a[1],
      d = a[2],
      p = a[3];
    return (
      (t[0] = r * p + o * b + u * d - e * m),
      (t[1] = u * p + o * m + e * b - r * d),
      (t[2] = e * p + o * d + r * m - u * b),
      (t[3] = o * p - r * b - u * m - e * d),
      (t[4] = r * s + o * i + u * c - e * h + M * p + v * b + f * d - l * m),
      (t[5] = u * s + o * h + e * i - r * c + f * p + v * m + l * b - M * d),
      (t[6] = e * s + o * c + r * h - u * i + l * p + v * d + M * m - f * b),
      (t[7] = o * s - r * i - u * h - e * c + v * p - M * b - f * m - l * d),
      t
    );
  }
  var xn = pn;
  var yn = Ct;
  var qn = Jt,
    gn = qn,
    _n = $t,
    An = _n;
  var wn = Object.freeze({
    __proto__: null,
    create: function () {
      var t = new a(8);
      return (
        a != Float32Array &&
          ((t[0] = 0),
          (t[1] = 0),
          (t[2] = 0),
          (t[4] = 0),
          (t[5] = 0),
          (t[6] = 0),
          (t[7] = 0)),
        (t[3] = 1),
        t
      );
    },
    clone: function (t) {
      var n = new a(8);
      return (
        (n[0] = t[0]),
        (n[1] = t[1]),
        (n[2] = t[2]),
        (n[3] = t[3]),
        (n[4] = t[4]),
        (n[5] = t[5]),
        (n[6] = t[6]),
        (n[7] = t[7]),
        n
      );
    },
    fromValues: function (t, n, r, u, e, o, i, h) {
      var c = new a(8);
      return (
        (c[0] = t),
        (c[1] = n),
        (c[2] = r),
        (c[3] = u),
        (c[4] = e),
        (c[5] = o),
        (c[6] = i),
        (c[7] = h),
        c
      );
    },
    fromRotationTranslationValues: function (t, n, r, u, e, o, i) {
      var h = new a(8);
      (h[0] = t), (h[1] = n), (h[2] = r), (h[3] = u);
      var c = 0.5 * e,
        s = 0.5 * o,
        M = 0.5 * i;
      return (
        (h[4] = c * u + s * r - M * n),
        (h[5] = s * u + M * t - c * r),
        (h[6] = M * u + c * n - s * t),
        (h[7] = -c * t - s * n - M * r),
        h
      );
    },
    fromRotationTranslation: vn,
    fromTranslation: function (t, n) {
      return (
        (t[0] = 0),
        (t[1] = 0),
        (t[2] = 0),
        (t[3] = 1),
        (t[4] = 0.5 * n[0]),
        (t[5] = 0.5 * n[1]),
        (t[6] = 0.5 * n[2]),
        (t[7] = 0),
        t
      );
    },
    fromRotation: function (t, n) {
      return (
        (t[0] = n[0]),
        (t[1] = n[1]),
        (t[2] = n[2]),
        (t[3] = n[3]),
        (t[4] = 0),
        (t[5] = 0),
        (t[6] = 0),
        (t[7] = 0),
        t
      );
    },
    fromMat4: function (t, n) {
      var r = Tt();
      O(r, n);
      var u = new a(3);
      return z(u, n), vn(t, r, u), t;
    },
    copy: bn,
    identity: function (t) {
      return (
        (t[0] = 0),
        (t[1] = 0),
        (t[2] = 0),
        (t[3] = 1),
        (t[4] = 0),
        (t[5] = 0),
        (t[6] = 0),
        (t[7] = 0),
        t
      );
    },
    set: function (t, n, a, r, u, e, o, i, h) {
      return (
        (t[0] = n),
        (t[1] = a),
        (t[2] = r),
        (t[3] = u),
        (t[4] = e),
        (t[5] = o),
        (t[6] = i),
        (t[7] = h),
        t
      );
    },
    getReal: mn,
    getDual: function (t, n) {
      return (t[0] = n[4]), (t[1] = n[5]), (t[2] = n[6]), (t[3] = n[7]), t;
    },
    setReal: dn,
    setDual: function (t, n) {
      return (t[4] = n[0]), (t[5] = n[1]), (t[6] = n[2]), (t[7] = n[3]), t;
    },
    getTranslation: function (t, n) {
      var a = n[4],
        r = n[5],
        u = n[6],
        e = n[7],
        o = -n[0],
        i = -n[1],
        h = -n[2],
        c = n[3];
      return (
        (t[0] = 2 * (a * c + e * o + r * h - u * i)),
        (t[1] = 2 * (r * c + e * i + u * o - a * h)),
        (t[2] = 2 * (u * c + e * h + a * i - r * o)),
        t
      );
    },
    translate: function (t, n, a) {
      var r = n[0],
        u = n[1],
        e = n[2],
        o = n[3],
        i = 0.5 * a[0],
        h = 0.5 * a[1],
        c = 0.5 * a[2],
        s = n[4],
        M = n[5],
        f = n[6],
        l = n[7];
      return (
        (t[0] = r),
        (t[1] = u),
        (t[2] = e),
        (t[3] = o),
        (t[4] = o * i + u * c - e * h + s),
        (t[5] = o * h + e * i - r * c + M),
        (t[6] = o * c + r * h - u * i + f),
        (t[7] = -r * i - u * h - e * c + l),
        t
      );
    },
    rotateX: function (t, n, a) {
      var r = -n[0],
        u = -n[1],
        e = -n[2],
        o = n[3],
        i = n[4],
        h = n[5],
        c = n[6],
        s = n[7],
        M = i * o + s * r + h * e - c * u,
        f = h * o + s * u + c * r - i * e,
        l = c * o + s * e + i * u - h * r,
        v = s * o - i * r - h * u - c * e;
      return (
        Ft(t, n, a),
        (r = t[0]),
        (u = t[1]),
        (e = t[2]),
        (o = t[3]),
        (t[4] = M * o + v * r + f * e - l * u),
        (t[5] = f * o + v * u + l * r - M * e),
        (t[6] = l * o + v * e + M * u - f * r),
        (t[7] = v * o - M * r - f * u - l * e),
        t
      );
    },
    rotateY: function (t, n, a) {
      var r = -n[0],
        u = -n[1],
        e = -n[2],
        o = n[3],
        i = n[4],
        h = n[5],
        c = n[6],
        s = n[7],
        M = i * o + s * r + h * e - c * u,
        f = h * o + s * u + c * r - i * e,
        l = c * o + s * e + i * u - h * r,
        v = s * o - i * r - h * u - c * e;
      return (
        It(t, n, a),
        (r = t[0]),
        (u = t[1]),
        (e = t[2]),
        (o = t[3]),
        (t[4] = M * o + v * r + f * e - l * u),
        (t[5] = f * o + v * u + l * r - M * e),
        (t[6] = l * o + v * e + M * u - f * r),
        (t[7] = v * o - M * r - f * u - l * e),
        t
      );
    },
    rotateZ: function (t, n, a) {
      var r = -n[0],
        u = -n[1],
        e = -n[2],
        o = n[3],
        i = n[4],
        h = n[5],
        c = n[6],
        s = n[7],
        M = i * o + s * r + h * e - c * u,
        f = h * o + s * u + c * r - i * e,
        l = c * o + s * e + i * u - h * r,
        v = s * o - i * r - h * u - c * e;
      return (
        Lt(t, n, a),
        (r = t[0]),
        (u = t[1]),
        (e = t[2]),
        (o = t[3]),
        (t[4] = M * o + v * r + f * e - l * u),
        (t[5] = f * o + v * u + l * r - M * e),
        (t[6] = l * o + v * e + M * u - f * r),
        (t[7] = v * o - M * r - f * u - l * e),
        t
      );
    },
    rotateByQuatAppend: function (t, n, a) {
      var r = a[0],
        u = a[1],
        e = a[2],
        o = a[3],
        i = n[0],
        h = n[1],
        c = n[2],
        s = n[3];
      return (
        (t[0] = i * o + s * r + h * e - c * u),
        (t[1] = h * o + s * u + c * r - i * e),
        (t[2] = c * o + s * e + i * u - h * r),
        (t[3] = s * o - i * r - h * u - c * e),
        (i = n[4]),
        (h = n[5]),
        (c = n[6]),
        (s = n[7]),
        (t[4] = i * o + s * r + h * e - c * u),
        (t[5] = h * o + s * u + c * r - i * e),
        (t[6] = c * o + s * e + i * u - h * r),
        (t[7] = s * o - i * r - h * u - c * e),
        t
      );
    },
    rotateByQuatPrepend: function (t, n, a) {
      var r = n[0],
        u = n[1],
        e = n[2],
        o = n[3],
        i = a[0],
        h = a[1],
        c = a[2],
        s = a[3];
      return (
        (t[0] = r * s + o * i + u * c - e * h),
        (t[1] = u * s + o * h + e * i - r * c),
        (t[2] = e * s + o * c + r * h - u * i),
        (t[3] = o * s - r * i - u * h - e * c),
        (i = a[4]),
        (h = a[5]),
        (c = a[6]),
        (s = a[7]),
        (t[4] = r * s + o * i + u * c - e * h),
        (t[5] = u * s + o * h + e * i - r * c),
        (t[6] = e * s + o * c + r * h - u * i),
        (t[7] = o * s - r * i - u * h - e * c),
        t
      );
    },
    rotateAroundAxis: function (t, a, r, u) {
      if (Math.abs(u) < n) return bn(t, a);
      var e = Math.hypot(r[0], r[1], r[2]);
      u *= 0.5;
      var o = Math.sin(u),
        i = (o * r[0]) / e,
        h = (o * r[1]) / e,
        c = (o * r[2]) / e,
        s = Math.cos(u),
        M = a[0],
        f = a[1],
        l = a[2],
        v = a[3];
      (t[0] = M * s + v * i + f * c - l * h),
        (t[1] = f * s + v * h + l * i - M * c),
        (t[2] = l * s + v * c + M * h - f * i),
        (t[3] = v * s - M * i - f * h - l * c);
      var b = a[4],
        m = a[5],
        d = a[6],
        p = a[7];
      return (
        (t[4] = b * s + p * i + m * c - d * h),
        (t[5] = m * s + p * h + d * i - b * c),
        (t[6] = d * s + p * c + b * h - m * i),
        (t[7] = p * s - b * i - m * h - d * c),
        t
      );
    },
    add: function (t, n, a) {
      return (
        (t[0] = n[0] + a[0]),
        (t[1] = n[1] + a[1]),
        (t[2] = n[2] + a[2]),
        (t[3] = n[3] + a[3]),
        (t[4] = n[4] + a[4]),
        (t[5] = n[5] + a[5]),
        (t[6] = n[6] + a[6]),
        (t[7] = n[7] + a[7]),
        t
      );
    },
    multiply: pn,
    mul: xn,
    scale: function (t, n, a) {
      return (
        (t[0] = n[0] * a),
        (t[1] = n[1] * a),
        (t[2] = n[2] * a),
        (t[3] = n[3] * a),
        (t[4] = n[4] * a),
        (t[5] = n[5] * a),
        (t[6] = n[6] * a),
        (t[7] = n[7] * a),
        t
      );
    },
    dot: yn,
    lerp: function (t, n, a, r) {
      var u = 1 - r;
      return (
        yn(n, a) < 0 && (r = -r),
        (t[0] = n[0] * u + a[0] * r),
        (t[1] = n[1] * u + a[1] * r),
        (t[2] = n[2] * u + a[2] * r),
        (t[3] = n[3] * u + a[3] * r),
        (t[4] = n[4] * u + a[4] * r),
        (t[5] = n[5] * u + a[5] * r),
        (t[6] = n[6] * u + a[6] * r),
        (t[7] = n[7] * u + a[7] * r),
        t
      );
    },
    invert: function (t, n) {
      var a = _n(n);
      return (
        (t[0] = -n[0] / a),
        (t[1] = -n[1] / a),
        (t[2] = -n[2] / a),
        (t[3] = n[3] / a),
        (t[4] = -n[4] / a),
        (t[5] = -n[5] / a),
        (t[6] = -n[6] / a),
        (t[7] = n[7] / a),
        t
      );
    },
    conjugate: function (t, n) {
      return (
        (t[0] = -n[0]),
        (t[1] = -n[1]),
        (t[2] = -n[2]),
        (t[3] = n[3]),
        (t[4] = -n[4]),
        (t[5] = -n[5]),
        (t[6] = -n[6]),
        (t[7] = n[7]),
        t
      );
    },
    length: qn,
    len: gn,
    squaredLength: _n,
    sqrLen: An,
    normalize: function (t, n) {
      var a = _n(n);
      if (a > 0) {
        a = Math.sqrt(a);
        var r = n[0] / a,
          u = n[1] / a,
          e = n[2] / a,
          o = n[3] / a,
          i = n[4],
          h = n[5],
          c = n[6],
          s = n[7],
          M = r * i + u * h + e * c + o * s;
        (t[0] = r),
          (t[1] = u),
          (t[2] = e),
          (t[3] = o),
          (t[4] = (i - r * M) / a),
          (t[5] = (h - u * M) / a),
          (t[6] = (c - e * M) / a),
          (t[7] = (s - o * M) / a);
      }
      return t;
    },
    str: function (t) {
      return (
        "quat2(" +
        t[0] +
        ", " +
        t[1] +
        ", " +
        t[2] +
        ", " +
        t[3] +
        ", " +
        t[4] +
        ", " +
        t[5] +
        ", " +
        t[6] +
        ", " +
        t[7] +
        ")"
      );
    },
    exactEquals: function (t, n) {
      return (
        t[0] === n[0] &&
        t[1] === n[1] &&
        t[2] === n[2] &&
        t[3] === n[3] &&
        t[4] === n[4] &&
        t[5] === n[5] &&
        t[6] === n[6] &&
        t[7] === n[7]
      );
    },
    equals: function (t, a) {
      var r = t[0],
        u = t[1],
        e = t[2],
        o = t[3],
        i = t[4],
        h = t[5],
        c = t[6],
        s = t[7],
        M = a[0],
        f = a[1],
        l = a[2],
        v = a[3],
        b = a[4],
        m = a[5],
        d = a[6],
        p = a[7];
      return (
        Math.abs(r - M) <= n * Math.max(1, Math.abs(r), Math.abs(M)) &&
        Math.abs(u - f) <= n * Math.max(1, Math.abs(u), Math.abs(f)) &&
        Math.abs(e - l) <= n * Math.max(1, Math.abs(e), Math.abs(l)) &&
        Math.abs(o - v) <= n * Math.max(1, Math.abs(o), Math.abs(v)) &&
        Math.abs(i - b) <= n * Math.max(1, Math.abs(i), Math.abs(b)) &&
        Math.abs(h - m) <= n * Math.max(1, Math.abs(h), Math.abs(m)) &&
        Math.abs(c - d) <= n * Math.max(1, Math.abs(c), Math.abs(d)) &&
        Math.abs(s - p) <= n * Math.max(1, Math.abs(s), Math.abs(p))
      );
    },
  });
  function zn() {
    var t = new a(2);
    return a != Float32Array && ((t[0] = 0), (t[1] = 0)), t;
  }
  function Rn(t, n, a) {
    return (t[0] = n[0] - a[0]), (t[1] = n[1] - a[1]), t;
  }
  function On(t, n, a) {
    return (t[0] = n[0] * a[0]), (t[1] = n[1] * a[1]), t;
  }
  function jn(t, n, a) {
    return (t[0] = n[0] / a[0]), (t[1] = n[1] / a[1]), t;
  }
  function En(t, n) {
    var a = n[0] - t[0],
      r = n[1] - t[1];
    return Math.hypot(a, r);
  }
  function Pn(t, n) {
    var a = n[0] - t[0],
      r = n[1] - t[1];
    return a * a + r * r;
  }
  function Tn(t) {
    var n = t[0],
      a = t[1];
    return Math.hypot(n, a);
  }
  function Sn(t) {
    var n = t[0],
      a = t[1];
    return n * n + a * a;
  }
  var Dn = Tn,
    Fn = Rn,
    In = On,
    Ln = jn,
    Vn = En,
    kn = Pn,
    Qn = Sn,
    Yn = (function () {
      var t = zn();
      return function (n, a, r, u, e, o) {
        var i, h;
        for (
          a || (a = 2),
            r || (r = 0),
            h = u ? Math.min(u * a + r, n.length) : n.length,
            i = r;
          i < h;
          i += a
        )
          (t[0] = n[i]),
            (t[1] = n[i + 1]),
            e(t, t, o),
            (n[i] = t[0]),
            (n[i + 1] = t[1]);
        return n;
      };
    })(),
    Zn = Object.freeze({
      __proto__: null,
      create: zn,
      clone: function (t) {
        var n = new a(2);
        return (n[0] = t[0]), (n[1] = t[1]), n;
      },
      fromValues: function (t, n) {
        var r = new a(2);
        return (r[0] = t), (r[1] = n), r;
      },
      copy: function (t, n) {
        return (t[0] = n[0]), (t[1] = n[1]), t;
      },
      set: function (t, n, a) {
        return (t[0] = n), (t[1] = a), t;
      },
      add: function (t, n, a) {
        return (t[0] = n[0] + a[0]), (t[1] = n[1] + a[1]), t;
      },
      subtract: Rn,
      multiply: On,
      divide: jn,
      ceil: function (t, n) {
        return (t[0] = Math.ceil(n[0])), (t[1] = Math.ceil(n[1])), t;
      },
      floor: function (t, n) {
        return (t[0] = Math.floor(n[0])), (t[1] = Math.floor(n[1])), t;
      },
      min: function (t, n, a) {
        return (t[0] = Math.min(n[0], a[0])), (t[1] = Math.min(n[1], a[1])), t;
      },
      max: function (t, n, a) {
        return (t[0] = Math.max(n[0], a[0])), (t[1] = Math.max(n[1], a[1])), t;
      },
      round: function (t, n) {
        return (t[0] = Math.round(n[0])), (t[1] = Math.round(n[1])), t;
      },
      scale: function (t, n, a) {
        return (t[0] = n[0] * a), (t[1] = n[1] * a), t;
      },
      scaleAndAdd: function (t, n, a, r) {
        return (t[0] = n[0] + a[0] * r), (t[1] = n[1] + a[1] * r), t;
      },
      distance: En,
      squaredDistance: Pn,
      length: Tn,
      squaredLength: Sn,
      negate: function (t, n) {
        return (t[0] = -n[0]), (t[1] = -n[1]), t;
      },
      inverse: function (t, n) {
        return (t[0] = 1 / n[0]), (t[1] = 1 / n[1]), t;
      },
      normalize: function (t, n) {
        var a = n[0],
          r = n[1],
          u = a * a + r * r;
        return (
          u > 0 && (u = 1 / Math.sqrt(u)),
          (t[0] = n[0] * u),
          (t[1] = n[1] * u),
          t
        );
      },
      dot: function (t, n) {
        return t[0] * n[0] + t[1] * n[1];
      },
      cross: function (t, n, a) {
        var r = n[0] * a[1] - n[1] * a[0];
        return (t[0] = t[1] = 0), (t[2] = r), t;
      },
      lerp: function (t, n, a, r) {
        var u = n[0],
          e = n[1];
        return (t[0] = u + r * (a[0] - u)), (t[1] = e + r * (a[1] - e)), t;
      },
      random: function (t, n) {
        n = void 0 === n ? 1 : n;
        var a = 2 * r() * Math.PI;
        return (t[0] = Math.cos(a) * n), (t[1] = Math.sin(a) * n), t;
      },
      transformMat2: function (t, n, a) {
        var r = n[0],
          u = n[1];
        return (t[0] = a[0] * r + a[2] * u), (t[1] = a[1] * r + a[3] * u), t;
      },
      transformMat2d: function (t, n, a) {
        var r = n[0],
          u = n[1];
        return (
          (t[0] = a[0] * r + a[2] * u + a[4]),
          (t[1] = a[1] * r + a[3] * u + a[5]),
          t
        );
      },
      transformMat3: function (t, n, a) {
        var r = n[0],
          u = n[1];
        return (
          (t[0] = a[0] * r + a[3] * u + a[6]),
          (t[1] = a[1] * r + a[4] * u + a[7]),
          t
        );
      },
      transformMat4: function (t, n, a) {
        var r = n[0],
          u = n[1];
        return (
          (t[0] = a[0] * r + a[4] * u + a[12]),
          (t[1] = a[1] * r + a[5] * u + a[13]),
          t
        );
      },
      rotate: function (t, n, a, r) {
        var u = n[0] - a[0],
          e = n[1] - a[1],
          o = Math.sin(r),
          i = Math.cos(r);
        return (t[0] = u * i - e * o + a[0]), (t[1] = u * o + e * i + a[1]), t;
      },
      angle: function (t, n) {
        var a = t[0],
          r = t[1],
          u = n[0],
          e = n[1],
          o = Math.sqrt((a * a + r * r) * (u * u + e * e)),
          i = o && (a * u + r * e) / o;
        return Math.acos(Math.min(Math.max(i, -1), 1));
      },
      zero: function (t) {
        return (t[0] = 0), (t[1] = 0), t;
      },
      str: function (t) {
        return "vec2(" + t[0] + ", " + t[1] + ")";
      },
      exactEquals: function (t, n) {
        return t[0] === n[0] && t[1] === n[1];
      },
      equals: function (t, a) {
        var r = t[0],
          u = t[1],
          e = a[0],
          o = a[1];
        return (
          Math.abs(r - e) <= n * Math.max(1, Math.abs(r), Math.abs(e)) &&
          Math.abs(u - o) <= n * Math.max(1, Math.abs(u), Math.abs(o))
        );
      },
      len: Dn,
      sub: Fn,
      mul: In,
      div: Ln,
      dist: Vn,
      sqrDist: kn,
      sqrLen: Qn,
      forEach: Yn,
    });
  (t.glMatrix = o),
    (t.mat2 = M),
    (t.mat2d = m),
    (t.mat3 = g),
    (t.mat4 = I),
    (t.quat = ln),
    (t.quat2 = wn),
    (t.vec2 = Zn),
    (t.vec3 = ut),
    (t.vec4 = Pt),
    Object.defineProperty(t, "__esModule", { value: !0 });
});

!(function (t, s) {
  "object" == typeof exports && "undefined" != typeof module
    ? (module.exports = s())
    : "function" == typeof define && define.amd
      ? define(s)
      : (t.proj4 = s());
})(this, function () {
  "use strict";
  function t(t, s) {
    if (t[s]) return t[s];
    for (
      var i, a = Object.keys(t), h = s.toLowerCase().replace(Ot, ""), e = -1;
      ++e < a.length;

    )
      if (((i = a[e]), i.toLowerCase().replace(Ot, "") === h)) return t[i];
  }
  function s(t) {
    if ("string" != typeof t) throw new Error("not a string");
    (this.text = t.trim()),
      (this.level = 0),
      (this.place = 0),
      (this.root = null),
      (this.stack = []),
      (this.currentObject = null),
      (this.state = qt);
  }
  function i(t) {
    return new s(t).output();
  }
  function a(t, s, i) {
    Array.isArray(s) && (i.unshift(s), (s = null));
    var a = s ? {} : t,
      e = i.reduce(function (t, s) {
        return h(s, t), t;
      }, a);
    s && (t[s] = e);
  }
  function h(t, s) {
    if (Array.isArray(t)) {
      var i = t.shift();
      if (("PARAMETER" === i && (i = t.shift()), 1 === t.length))
        return Array.isArray(t[0])
          ? ((s[i] = {}), void h(t[0], s[i]))
          : void (s[i] = t[0]);
      if (t.length)
        if ("TOWGS84" !== i) {
          if ("AXIS" === i) return i in s || (s[i] = []), void s[i].push(t);
          Array.isArray(i) || (s[i] = {});
          var e;
          switch (i) {
            case "UNIT":
            case "PRIMEM":
            case "VERT_DATUM":
              return (
                (s[i] = { name: t[0].toLowerCase(), convert: t[1] }),
                void (3 === t.length && h(t[2], s[i]))
              );
            case "SPHEROID":
            case "ELLIPSOID":
              return (
                (s[i] = { name: t[0], a: t[1], rf: t[2] }),
                void (4 === t.length && h(t[3], s[i]))
              );
            case "PROJECTEDCRS":
            case "PROJCRS":
            case "GEOGCS":
            case "GEOCCS":
            case "PROJCS":
            case "LOCAL_CS":
            case "GEODCRS":
            case "GEODETICCRS":
            case "GEODETICDATUM":
            case "EDATUM":
            case "ENGINEERINGDATUM":
            case "VERT_CS":
            case "VERTCRS":
            case "VERTICALCRS":
            case "COMPD_CS":
            case "COMPOUNDCRS":
            case "ENGINEERINGCRS":
            case "ENGCRS":
            case "FITTED_CS":
            case "LOCAL_DATUM":
            case "DATUM":
              return (t[0] = ["name", t[0]]), void a(s, i, t);
            default:
              for (e = -1; ++e < t.length; )
                if (!Array.isArray(t[e])) return h(t, s[i]);
              return a(s, i, t);
          }
        } else s[i] = t;
      else s[i] = !0;
    } else s[t] = !0;
  }
  function e(t, s) {
    var i = s[0],
      a = s[1];
    !(i in t) &&
      a in t &&
      ((t[i] = t[a]), 3 === s.length && (t[i] = s[2](t[i])));
  }
  function n(t) {
    return t * Bt;
  }
  function r(t) {
    function s(s) {
      return s * (t.to_meter || 1);
    }
    if (
      ("GEOGCS" === t.type
        ? (t.projName = "longlat")
        : "LOCAL_CS" === t.type
          ? ((t.projName = "identity"), (t.local = !0))
          : "object" == typeof t.PROJECTION
            ? (t.projName = Object.keys(t.PROJECTION)[0])
            : (t.projName = t.PROJECTION),
      t.AXIS)
    ) {
      for (var i = "", a = 0, h = t.AXIS.length; a < h; ++a) {
        var r = [t.AXIS[a][0].toLowerCase(), t.AXIS[a][1].toLowerCase()];
        -1 !== r[0].indexOf("north") ||
        (("y" === r[0] || "lat" === r[0]) && "north" === r[1])
          ? (i += "n")
          : -1 !== r[0].indexOf("south") ||
              (("y" === r[0] || "lat" === r[0]) && "south" === r[1])
            ? (i += "s")
            : -1 !== r[0].indexOf("east") ||
                (("x" === r[0] || "lon" === r[0]) && "east" === r[1])
              ? (i += "e")
              : (-1 === r[0].indexOf("west") &&
                  (("x" !== r[0] && "lon" !== r[0]) || "west" !== r[1])) ||
                (i += "w");
      }
      2 === i.length && (i += "u"), 3 === i.length && (t.axis = i);
    }
    t.UNIT &&
      ((t.units = t.UNIT.name.toLowerCase()),
      "metre" === t.units && (t.units = "meter"),
      t.UNIT.convert &&
        ("GEOGCS" === t.type
          ? t.DATUM &&
            t.DATUM.SPHEROID &&
            (t.to_meter = t.UNIT.convert * t.DATUM.SPHEROID.a)
          : (t.to_meter = t.UNIT.convert)));
    var o = t.GEOGCS;
    "GEOGCS" === t.type && (o = t),
      o &&
        (o.DATUM
          ? (t.datumCode = o.DATUM.name.toLowerCase())
          : (t.datumCode = o.name.toLowerCase()),
        "d_" === t.datumCode.slice(0, 2) &&
          (t.datumCode = t.datumCode.slice(2)),
        ("new_zealand_geodetic_datum_1949" !== t.datumCode &&
          "new_zealand_1949" !== t.datumCode) ||
          (t.datumCode = "nzgd49"),
        ("wgs_1984" !== t.datumCode &&
          "world_geodetic_system_1984" !== t.datumCode) ||
          ("Mercator_Auxiliary_Sphere" === t.PROJECTION && (t.sphere = !0),
          (t.datumCode = "wgs84")),
        "_ferro" === t.datumCode.slice(-6) &&
          (t.datumCode = t.datumCode.slice(0, -6)),
        "_jakarta" === t.datumCode.slice(-8) &&
          (t.datumCode = t.datumCode.slice(0, -8)),
        ~t.datumCode.indexOf("belge") && (t.datumCode = "rnb72"),
        o.DATUM &&
          o.DATUM.SPHEROID &&
          ((t.ellps = o.DATUM.SPHEROID.name
            .replace("_19", "")
            .replace(/[Cc]larke\_18/, "clrk")),
          "international" === t.ellps.toLowerCase().slice(0, 13) &&
            (t.ellps = "intl"),
          (t.a = o.DATUM.SPHEROID.a),
          (t.rf = parseFloat(o.DATUM.SPHEROID.rf, 10))),
        o.DATUM && o.DATUM.TOWGS84 && (t.datum_params = o.DATUM.TOWGS84),
        ~t.datumCode.indexOf("osgb_1936") && (t.datumCode = "osgb36"),
        ~t.datumCode.indexOf("osni_1952") && (t.datumCode = "osni52"),
        (~t.datumCode.indexOf("tm65") ||
          ~t.datumCode.indexOf("geodetic_datum_of_1965")) &&
          (t.datumCode = "ire65"),
        "ch1903+" === t.datumCode && (t.datumCode = "ch1903"),
        ~t.datumCode.indexOf("israel") && (t.datumCode = "isr93")),
      t.b && !isFinite(t.b) && (t.b = t.a);
    [
      ["standard_parallel_1", "Standard_Parallel_1"],
      ["standard_parallel_1", "Latitude of 1st standard parallel"],
      ["standard_parallel_2", "Standard_Parallel_2"],
      ["standard_parallel_2", "Latitude of 2nd standard parallel"],
      ["false_easting", "False_Easting"],
      ["false_easting", "False easting"],
      ["false-easting", "Easting at false origin"],
      ["false_northing", "False_Northing"],
      ["false_northing", "False northing"],
      ["false_northing", "Northing at false origin"],
      ["central_meridian", "Central_Meridian"],
      ["central_meridian", "Longitude of natural origin"],
      ["central_meridian", "Longitude of false origin"],
      ["latitude_of_origin", "Latitude_Of_Origin"],
      ["latitude_of_origin", "Central_Parallel"],
      ["latitude_of_origin", "Latitude of natural origin"],
      ["latitude_of_origin", "Latitude of false origin"],
      ["scale_factor", "Scale_Factor"],
      ["k0", "scale_factor"],
      ["latitude_of_center", "Latitude_Of_Center"],
      ["latitude_of_center", "Latitude_of_center"],
      ["lat0", "latitude_of_center", n],
      ["longitude_of_center", "Longitude_Of_Center"],
      ["longitude_of_center", "Longitude_of_center"],
      ["longc", "longitude_of_center", n],
      ["x0", "false_easting", s],
      ["y0", "false_northing", s],
      ["long0", "central_meridian", n],
      ["lat0", "latitude_of_origin", n],
      ["lat0", "standard_parallel_1", n],
      ["lat1", "standard_parallel_1", n],
      ["lat2", "standard_parallel_2", n],
      ["azimuth", "Azimuth"],
      ["alpha", "azimuth", n],
      ["srsCode", "name"],
    ].forEach(function (s) {
      return e(t, s);
    }),
      t.long0 ||
        !t.longc ||
        ("Albers_Conic_Equal_Area" !== t.projName &&
          "Lambert_Azimuthal_Equal_Area" !== t.projName) ||
        (t.long0 = t.longc),
      t.lat_ts ||
      !t.lat1 ||
      ("Stereographic_South_Pole" !== t.projName &&
        "Polar Stereographic (variant B)" !== t.projName)
        ? !t.lat_ts &&
          t.lat0 &&
          "Polar_Stereographic" === t.projName &&
          ((t.lat_ts = t.lat0), (t.lat0 = n(t.lat0 > 0 ? 90 : -90)))
        : ((t.lat0 = n(t.lat1 > 0 ? 90 : -90)), (t.lat_ts = t.lat1));
  }
  function o(t) {
    var s = this;
    if (2 === arguments.length) {
      var i = arguments[1];
      "string" == typeof i
        ? "+" === i.charAt(0)
          ? (o[t] = kt(arguments[1]))
          : (o[t] = zt(arguments[1]))
        : (o[t] = i);
    } else if (1 === arguments.length) {
      if (Array.isArray(t))
        return t.map(function (t) {
          Array.isArray(t) ? o.apply(s, t) : o(t);
        });
      if ("string" == typeof t) {
        if (t in o) return o[t];
      } else
        "EPSG" in t
          ? (o["EPSG:" + t.EPSG] = t)
          : "ESRI" in t
            ? (o["ESRI:" + t.ESRI] = t)
            : "IAU2000" in t
              ? (o["IAU2000:" + t.IAU2000] = t)
              : console.log(t);
      return;
    }
  }
  function l(t) {
    return "string" == typeof t;
  }
  function u(t) {
    return t in o;
  }
  function c(t) {
    return Ft.some(function (s) {
      return t.indexOf(s) > -1;
    });
  }
  function M(s) {
    var i = t(s, "authority");
    if (i) {
      var a = t(i, "epsg");
      return a && Dt.indexOf(a) > -1;
    }
  }
  function f(s) {
    var i = t(s, "extension");
    if (i) return t(i, "proj4");
  }
  function d(t) {
    return "+" === t[0];
  }
  function p(t) {
    if (!l(t)) return t;
    if (u(t)) return o[t];
    if (c(t)) {
      var s = zt(t);
      if (M(s)) return o["EPSG:3857"];
      var i = f(s);
      return i ? kt(i) : s;
    }
    return d(t) ? kt(t) : void 0;
  }
  function m(t) {
    return t;
  }
  function y(t, s) {
    var i = Zt.length;
    return t.names
      ? ((Zt[i] = t),
        t.names.forEach(function (t) {
          Vt[t.toLowerCase()] = i;
        }),
        this)
      : (console.log(s), !0);
  }
  function _(t, s, i, a) {
    var h = t * t,
      e = s * s,
      n = (h - e) / h,
      r = 0;
    return (
      a
        ? ((h = (t *= 1 - n * (gt + n * (vt + n * bt))) * t), (n = 0))
        : (r = Math.sqrt(n)),
      { es: n, e: r, ep2: (h - e) / e }
    );
  }
  function x(s, i, a, h, e) {
    if (!s) {
      var n = t($t, h);
      n || (n = ts), (s = n.a), (i = n.b), (a = n.rf);
    }
    return (
      a && !i && (i = (1 - 1 / a) * s),
      (0 === a || Math.abs(s - i) < wt) && ((e = !0), (i = s)),
      { a: s, b: i, rf: a, sphere: e }
    );
  }
  function g(t, s, i, a, h, e, n) {
    var r = {};
    return (
      (r.datum_type = void 0 === t || "none" === t ? yt : mt),
      s &&
        ((r.datum_params = s.map(parseFloat)),
        (0 === r.datum_params[0] &&
          0 === r.datum_params[1] &&
          0 === r.datum_params[2]) ||
          (r.datum_type = ft),
        r.datum_params.length > 3 &&
          ((0 === r.datum_params[3] &&
            0 === r.datum_params[4] &&
            0 === r.datum_params[5] &&
            0 === r.datum_params[6]) ||
            ((r.datum_type = dt),
            (r.datum_params[3] *= _t),
            (r.datum_params[4] *= _t),
            (r.datum_params[5] *= _t),
            (r.datum_params[6] = r.datum_params[6] / 1e6 + 1)))),
      n && ((r.datum_type = pt), (r.grids = n)),
      (r.a = i),
      (r.b = a),
      (r.es = h),
      (r.ep2 = e),
      r
    );
  }
  function v(t) {
    return void 0 === t ? null : t.split(",").map(b);
  }
  function b(t) {
    if (0 === t.length) return null;
    var s = "@" === t[0];
    return (
      s && (t = t.slice(1)),
      "null" === t
        ? { name: "null", mandatory: !s, grid: null, isNull: !0 }
        : { name: t, mandatory: !s, grid: is[t] || null, isNull: !1 }
    );
  }
  function w(t) {
    return ((t / 3600) * Math.PI) / 180;
  }
  function N(t) {
    var s = t.getInt32(8, !1);
    return (
      11 !== s &&
      (11 !== (s = t.getInt32(8, !0)) &&
        console.warn(
          "Failed to detect nadgrid endian-ness, defaulting to little-endian",
        ),
      !0)
    );
  }
  function E(t, s) {
    return {
      nFields: t.getInt32(8, s),
      nSubgridFields: t.getInt32(24, s),
      nSubgrids: t.getInt32(40, s),
      shiftType: A(t, 56, 64).trim(),
      fromSemiMajorAxis: t.getFloat64(120, s),
      fromSemiMinorAxis: t.getFloat64(136, s),
      toSemiMajorAxis: t.getFloat64(152, s),
      toSemiMinorAxis: t.getFloat64(168, s),
    };
  }
  function A(t, s, i) {
    return String.fromCharCode.apply(
      null,
      new Uint8Array(t.buffer.slice(s, i)),
    );
  }
  function C(t, s, i) {
    for (var a = 176, h = [], e = 0; e < s.nSubgrids; e++) {
      var n = S(t, a, i),
        r = I(t, a, n, i),
        o = Math.round(
          1 + (n.upperLongitude - n.lowerLongitude) / n.longitudeInterval,
        ),
        l = Math.round(
          1 + (n.upperLatitude - n.lowerLatitude) / n.latitudeInterval,
        );
      h.push({
        ll: [w(n.lowerLongitude), w(n.lowerLatitude)],
        del: [w(n.longitudeInterval), w(n.latitudeInterval)],
        lim: [o, l],
        count: n.gridNodeCount,
        cvs: P(r),
      }),
        (a += 176 + 16 * n.gridNodeCount);
    }
    return h;
  }
  function P(t) {
    return t.map(function (t) {
      return [w(t.longitudeShift), w(t.latitudeShift)];
    });
  }
  function S(t, s, i) {
    return {
      name: A(t, s + 8, s + 16).trim(),
      parent: A(t, s + 24, s + 24 + 8).trim(),
      lowerLatitude: t.getFloat64(s + 72, i),
      upperLatitude: t.getFloat64(s + 88, i),
      lowerLongitude: t.getFloat64(s + 104, i),
      upperLongitude: t.getFloat64(s + 120, i),
      latitudeInterval: t.getFloat64(s + 136, i),
      longitudeInterval: t.getFloat64(s + 152, i),
      gridNodeCount: t.getInt32(s + 168, i),
    };
  }
  function I(t, s, i, a) {
    for (var h = s + 176, e = [], n = 0; n < i.gridNodeCount; n++) {
      var r = {
        latitudeShift: t.getFloat32(h + 16 * n, a),
        longitudeShift: t.getFloat32(h + 16 * n + 4, a),
        latitudeAccuracy: t.getFloat32(h + 16 * n + 8, a),
        longitudeAccuracy: t.getFloat32(h + 16 * n + 12, a),
      };
      e.push(r);
    }
    return e;
  }
  function Projection(s, i) {
    if (!(this instanceof Projection)) return new Projection(s);
    i =
      i ||
      function (t) {
        if (t) throw t;
      };
    var a = p(s);
    if ("object" == typeof a) {
      var h = Projection.projections.get(a.projName);
      if (h) {
        if (a.datumCode && "none" !== a.datumCode) {
          var e = t(ss, a.datumCode);
          e &&
            ((a.datum_params =
              a.datum_params || (e.towgs84 ? e.towgs84.split(",") : null)),
            (a.ellps = e.ellipse),
            (a.datumName = e.datumName ? e.datumName : a.datumCode));
        }
        (a.k0 = a.k0 || 1),
          (a.axis = a.axis || "enu"),
          (a.ellps = a.ellps || "wgs84"),
          (a.lat1 = a.lat1 || a.lat0);
        var n = x(a.a, a.b, a.rf, a.ellps, a.sphere),
          r = _(n.a, n.b, n.rf, a.R_A),
          o = v(a.nadgrids),
          l =
            a.datum || g(a.datumCode, a.datum_params, n.a, n.b, r.es, r.ep2, o);
        Ut(this, a),
          Ut(this, h),
          (this.a = n.a),
          (this.b = n.b),
          (this.rf = n.rf),
          (this.sphere = n.sphere),
          (this.es = r.es),
          (this.e = r.e),
          (this.ep2 = r.ep2),
          (this.datum = l),
          this.init(),
          i(null, this);
      } else i(s);
    } else i(s);
  }
  function O(t, s) {
    return (
      t.datum_type === s.datum_type &&
      !(t.a !== s.a || Math.abs(t.es - s.es) > 5e-11) &&
      (t.datum_type === ft
        ? t.datum_params[0] === s.datum_params[0] &&
          t.datum_params[1] === s.datum_params[1] &&
          t.datum_params[2] === s.datum_params[2]
        : t.datum_type !== dt ||
          (t.datum_params[0] === s.datum_params[0] &&
            t.datum_params[1] === s.datum_params[1] &&
            t.datum_params[2] === s.datum_params[2] &&
            t.datum_params[3] === s.datum_params[3] &&
            t.datum_params[4] === s.datum_params[4] &&
            t.datum_params[5] === s.datum_params[5] &&
            t.datum_params[6] === s.datum_params[6]))
    );
  }
  function k(t, s, i) {
    var a,
      h,
      e,
      n,
      r = t.x,
      o = t.y,
      l = t.z ? t.z : 0;
    if (o < -xt && o > -1.001 * xt) o = -xt;
    else if (o > xt && o < 1.001 * xt) o = xt;
    else {
      if (o < -xt) return { x: -1 / 0, y: -1 / 0, z: t.z };
      if (o > xt) return { x: 1 / 0, y: 1 / 0, z: t.z };
    }
    return (
      r > Math.PI && (r -= 2 * Math.PI),
      (h = Math.sin(o)),
      (n = Math.cos(o)),
      (e = h * h),
      (a = i / Math.sqrt(1 - s * e)),
      {
        x: (a + l) * n * Math.cos(r),
        y: (a + l) * n * Math.sin(r),
        z: (a * (1 - s) + l) * h,
      }
    );
  }
  function q(t, s, i, a) {
    var h,
      e,
      n,
      r,
      o,
      l,
      u,
      c,
      M,
      f,
      d,
      p,
      m,
      y,
      _,
      x,
      g = t.x,
      v = t.y,
      b = t.z ? t.z : 0;
    if (
      ((h = Math.sqrt(g * g + v * v)),
      (e = Math.sqrt(g * g + v * v + b * b)),
      h / i < 1e-12)
    ) {
      if (((y = 0), e / i < 1e-12))
        return (_ = xt), (x = -a), { x: t.x, y: t.y, z: t.z };
    } else y = Math.atan2(v, g);
    (n = b / e),
      (c =
        (r = h / e) * (1 - s) * (o = 1 / Math.sqrt(1 - s * (2 - s) * r * r))),
      (M = n * o),
      (m = 0);
    do {
      m++,
        (l =
          (s * (u = i / Math.sqrt(1 - s * M * M))) /
          (u + (x = h * c + b * M - u * (1 - s * M * M)))),
        (p =
          (d = n * (o = 1 / Math.sqrt(1 - l * (2 - l) * r * r))) * c -
          (f = r * (1 - l) * o) * M),
        (c = f),
        (M = d);
    } while (p * p > 1e-24 && m < 30);
    return (_ = Math.atan(d / Math.abs(f))), { x: y, y: _, z: x };
  }
  function R(t, s, i) {
    if (s === ft) return { x: t.x + i[0], y: t.y + i[1], z: t.z + i[2] };
    if (s === dt) {
      var a = i[0],
        h = i[1],
        e = i[2],
        n = i[3],
        r = i[4],
        o = i[5],
        l = i[6];
      return {
        x: l * (t.x - o * t.y + r * t.z) + a,
        y: l * (o * t.x + t.y - n * t.z) + h,
        z: l * (-r * t.x + n * t.y + t.z) + e,
      };
    }
  }
  function L(t, s, i) {
    if (s === ft) return { x: t.x - i[0], y: t.y - i[1], z: t.z - i[2] };
    if (s === dt) {
      var a = i[0],
        h = i[1],
        e = i[2],
        n = i[3],
        r = i[4],
        o = i[5],
        l = i[6],
        u = (t.x - a) / l,
        c = (t.y - h) / l,
        M = (t.z - e) / l;
      return {
        x: u + o * c - r * M,
        y: -o * u + c + n * M,
        z: r * u - n * c + M,
      };
    }
  }
  function G(t) {
    return t === ft || t === dt;
  }
  function T(t, s, i) {
    if (null === t.grids || 0 === t.grids.length)
      return console.log("Grid shift grids not found"), -1;
    var a = { x: -i.x, y: i.y },
      h = { x: Number.NaN, y: Number.NaN },
      e = [];
    t: for (var n = 0; n < t.grids.length; n++) {
      var r = t.grids[n];
      if ((e.push(r.name), r.isNull)) {
        h = a;
        break;
      }
      if (null !== r.grid)
        for (var o = r.grid.subgrids, l = 0, u = o.length; l < u; l++) {
          var c = o[l],
            M = (Math.abs(c.del[1]) + Math.abs(c.del[0])) / 1e4,
            f = c.ll[0] - M,
            d = c.ll[1] - M,
            p = c.ll[0] + (c.lim[0] - 1) * c.del[0] + M,
            m = c.ll[1] + (c.lim[1] - 1) * c.del[1] + M;
          if (
            !(d > a.y || f > a.x || m < a.y || p < a.x) &&
            ((h = j(a, s, c)), !isNaN(h.x))
          )
            break t;
        }
      else if (r.mandatory)
        return (
          console.log("Unable to find mandatory grid '" + r.name + "'"), -1
        );
    }
    return isNaN(h.x)
      ? (console.log(
          "Failed to find a grid shift table for location '" +
            -a.x * Et +
            " " +
            a.y * Et +
            " tried: '" +
            e +
            "'",
        ),
        -1)
      : ((i.x = -h.x), (i.y = h.y), 0);
  }
  function j(t, s, i) {
    var a = { x: Number.NaN, y: Number.NaN };
    if (isNaN(t.x)) return a;
    var h = { x: t.x, y: t.y };
    (h.x -= i.ll[0]), (h.y -= i.ll[1]), (h.x = Ht(h.x - Math.PI) + Math.PI);
    var e = B(h, i);
    if (s) {
      if (isNaN(e.x)) return a;
      (e.x = h.x - e.x), (e.y = h.y - e.y);
      var n,
        r,
        o = 9;
      do {
        if (((r = B(e, i)), isNaN(r.x))) {
          console.log(
            "Inverse grid shift iteration failed, presumably at grid edge.  Using first approximation.",
          );
          break;
        }
        (n = { x: h.x - (r.x + e.x), y: h.y - (r.y + e.y) }),
          (e.x += n.x),
          (e.y += n.y);
      } while (o-- && Math.abs(n.x) > 1e-12 && Math.abs(n.y) > 1e-12);
      if (o < 0)
        return (
          console.log("Inverse grid shift iterator failed to converge."), a
        );
      (a.x = Ht(e.x + i.ll[0])), (a.y = e.y + i.ll[1]);
    } else isNaN(e.x) || ((a.x = t.x + e.x), (a.y = t.y + e.y));
    return a;
  }
  function B(t, s) {
    var i,
      a = { x: t.x / s.del[0], y: t.y / s.del[1] },
      h = { x: Math.floor(a.x), y: Math.floor(a.y) },
      e = { x: a.x - 1 * h.x, y: a.y - 1 * h.y },
      n = { x: Number.NaN, y: Number.NaN };
    if (h.x < 0 || h.x >= s.lim[0]) return n;
    if (h.y < 0 || h.y >= s.lim[1]) return n;
    i = h.y * s.lim[0] + h.x;
    var r = { x: s.cvs[i][0], y: s.cvs[i][1] };
    i++;
    var o = { x: s.cvs[i][0], y: s.cvs[i][1] };
    i += s.lim[0];
    var l = { x: s.cvs[i][0], y: s.cvs[i][1] };
    i--;
    var u = { x: s.cvs[i][0], y: s.cvs[i][1] },
      c = e.x * e.y,
      M = e.x * (1 - e.y),
      f = (1 - e.x) * (1 - e.y),
      d = (1 - e.x) * e.y;
    return (
      (n.x = f * r.x + M * o.x + d * u.x + c * l.x),
      (n.y = f * r.y + M * o.y + d * u.y + c * l.y),
      n
    );
  }
  function z(t) {
    if ("function" == typeof Number.isFinite) {
      if (Number.isFinite(t)) return;
      throw new TypeError("coordinates must be finite numbers");
    }
    if ("number" != typeof t || t !== t || !isFinite(t))
      throw new TypeError("coordinates must be finite numbers");
  }
  function F(t, s) {
    return (
      ((t.datum.datum_type === ft ||
        t.datum.datum_type === dt ||
        t.datum.datum_type === pt) &&
        "WGS84" !== s.datumCode) ||
      ((s.datum.datum_type === ft ||
        s.datum.datum_type === dt ||
        s.datum.datum_type === pt) &&
        "WGS84" !== t.datumCode)
    );
  }
  function D(t, s, i, a) {
    var h,
      e =
        void 0 !==
        (i = Array.isArray(i) ? es(i) : { x: i.x, y: i.y, z: i.z, m: i.m }).z;
    if (
      (ns(i),
      t.datum &&
        s.datum &&
        F(t, s) &&
        ((i = D(t, (h = new Projection("WGS84")), i, a)), (t = h)),
      a && "enu" !== t.axis && (i = hs(t, !1, i)),
      "longlat" === t.projName)
    )
      i = { x: i.x * Nt, y: i.y * Nt, z: i.z || 0 };
    else if (
      (t.to_meter &&
        (i = { x: i.x * t.to_meter, y: i.y * t.to_meter, z: i.z || 0 }),
      !(i = t.inverse(i)))
    )
      return;
    if (
      (t.from_greenwich && (i.x += t.from_greenwich),
      (i = as(t.datum, s.datum, i)))
    )
      return (
        s.from_greenwich &&
          (i = { x: i.x - s.from_greenwich, y: i.y, z: i.z || 0 }),
        "longlat" === s.projName
          ? (i = { x: i.x * Et, y: i.y * Et, z: i.z || 0 })
          : ((i = s.forward(i)),
            s.to_meter &&
              (i = { x: i.x / s.to_meter, y: i.y / s.to_meter, z: i.z || 0 })),
        a && "enu" !== s.axis ? hs(s, !0, i) : (i && !e && delete i.z, i)
      );
  }
  function U(t, s, i, a) {
    var h, e, n;
    return Array.isArray(i)
      ? ((h = D(t, s, i, a) || { x: NaN, y: NaN }),
        i.length > 2
          ? (void 0 !== t.name && "geocent" === t.name) ||
            (void 0 !== s.name && "geocent" === s.name)
            ? "number" == typeof h.z
              ? [h.x, h.y, h.z].concat(i.splice(3))
              : [h.x, h.y, i[2]].concat(i.splice(3))
            : [h.x, h.y].concat(i.splice(2))
          : [h.x, h.y])
      : ((e = D(t, s, i, a)),
        2 === (n = Object.keys(i)).length
          ? e
          : (n.forEach(function (a) {
              if (
                (void 0 !== t.name && "geocent" === t.name) ||
                (void 0 !== s.name && "geocent" === s.name)
              ) {
                if ("x" === a || "y" === a || "z" === a) return;
              } else if ("x" === a || "y" === a) return;
              e[a] = i[a];
            }),
            e));
  }
  function Q(t) {
    return t instanceof Projection ? t : t.oProj ? t.oProj : Projection(t);
  }
  function W(t, s, i) {
    t = Q(t);
    var a,
      h = !1;
    return (
      void 0 === s
        ? ((s = t), (t = rs), (h = !0))
        : (void 0 !== s.x || Array.isArray(s)) &&
          ((i = s), (s = t), (t = rs), (h = !0)),
      (s = Q(s)),
      i
        ? U(t, s, i)
        : ((a = {
            forward: function (i, a) {
              return U(t, s, i, a);
            },
            inverse: function (i, a) {
              return U(s, t, i, a);
            },
          }),
          h && (a.oProj = s),
          a)
    );
  }
  function H(t, s) {
    return (s = s || 5), $(V({ lat: t[1], lon: t[0] }), s);
  }
  function X(t) {
    var s = Z(at(t.toUpperCase()));
    return s.lat && s.lon
      ? [s.lon, s.lat]
      : [(s.left + s.right) / 2, (s.top + s.bottom) / 2];
  }
  function K(t) {
    return t * (Math.PI / 180);
  }
  function J(t) {
    return (t / Math.PI) * 180;
  }
  function V(t) {
    var s,
      i,
      a,
      h,
      e,
      n,
      r,
      o = t.lat,
      l = t.lon,
      u = 6378137,
      c = K(o),
      M = K(l);
    (r = Math.floor((l + 180) / 6) + 1),
      180 === l && (r = 60),
      o >= 56 && o < 64 && l >= 3 && l < 12 && (r = 32),
      o >= 72 &&
        o < 84 &&
        (l >= 0 && l < 9
          ? (r = 31)
          : l >= 9 && l < 21
            ? (r = 33)
            : l >= 21 && l < 33
              ? (r = 35)
              : l >= 33 && l < 42 && (r = 37)),
      (n = K(6 * (r - 1) - 180 + 3)),
      (s = u / Math.sqrt(1 - 0.00669438 * Math.sin(c) * Math.sin(c))),
      (i = Math.tan(c) * Math.tan(c)),
      (a = 0.006739496752268451 * Math.cos(c) * Math.cos(c));
    var f =
        0.9996 *
          s *
          ((h = Math.cos(c) * (M - n)) +
            ((1 - i + a) * h * h * h) / 6 +
            ((5 - 18 * i + i * i + 72 * a - 0.39089081163157013) *
              h *
              h *
              h *
              h *
              h) /
              120) +
        5e5,
      d =
        0.9996 *
        ((e =
          u *
          (0.9983242984503243 * c -
            0.002514607064228144 * Math.sin(2 * c) +
            2639046602129982e-21 * Math.sin(4 * c) -
            3.418046101696858e-9 * Math.sin(6 * c))) +
          s *
            Math.tan(c) *
            ((h * h) / 2 +
              ((5 - i + 9 * a + 4 * a * a) * h * h * h * h) / 24 +
              ((61 - 58 * i + i * i + 600 * a - 2.2240339282485886) *
                h *
                h *
                h *
                h *
                h *
                h) /
                720));
    return (
      o < 0 && (d += 1e7),
      {
        northing: Math.round(d),
        easting: Math.round(f),
        zoneNumber: r,
        zoneLetter: Y(o),
      }
    );
  }
  function Z(t) {
    var s = t.northing,
      i = t.easting,
      a = t.zoneLetter,
      h = t.zoneNumber;
    if (h < 0 || h > 60) return null;
    var e,
      n,
      r,
      o,
      l,
      u,
      c,
      M,
      f = 6378137,
      d = (1 - Math.sqrt(0.99330562)) / (1 + Math.sqrt(0.99330562)),
      p = i - 5e5,
      m = s;
    a < "N" && (m -= 1e7),
      (u = 6 * (h - 1) - 180 + 3),
      (M =
        (c = m / 0.9996 / 6367449.145945056) +
        ((3 * d) / 2 - (27 * d * d * d) / 32) * Math.sin(2 * c) +
        ((21 * d * d) / 16 - (55 * d * d * d * d) / 32) * Math.sin(4 * c) +
        ((151 * d * d * d) / 96) * Math.sin(6 * c)),
      (e = f / Math.sqrt(1 - 0.00669438 * Math.sin(M) * Math.sin(M))),
      (n = Math.tan(M) * Math.tan(M)),
      (r = 0.006739496752268451 * Math.cos(M) * Math.cos(M)),
      (o =
        (0.99330562 * f) /
        Math.pow(1 - 0.00669438 * Math.sin(M) * Math.sin(M), 1.5)),
      (l = p / (0.9996 * e));
    var y =
      M -
      ((e * Math.tan(M)) / o) *
        ((l * l) / 2 -
          ((5 + 3 * n + 10 * r - 4 * r * r - 0.06065547077041606) *
            l *
            l *
            l *
            l) /
            24 +
          ((61 +
            90 * n +
            298 * r +
            45 * n * n -
            1.6983531815716497 -
            3 * r * r) *
            l *
            l *
            l *
            l *
            l *
            l) /
            720);
    y = J(y);
    var _ =
      (l -
        ((1 + 2 * n + r) * l * l * l) / 6 +
        ((5 - 2 * r + 28 * n - 3 * r * r + 0.05391597401814761 + 24 * n * n) *
          l *
          l *
          l *
          l *
          l) /
          120) /
      Math.cos(M);
    _ = u + J(_);
    var x;
    if (t.accuracy) {
      var g = Z({
        northing: t.northing + t.accuracy,
        easting: t.easting + t.accuracy,
        zoneLetter: t.zoneLetter,
        zoneNumber: t.zoneNumber,
      });
      x = { top: g.lat, right: g.lon, bottom: y, left: _ };
    } else x = { lat: y, lon: _ };
    return x;
  }
  function Y(t) {
    var s = "Z";
    return (
      84 >= t && t >= 72
        ? (s = "X")
        : 72 > t && t >= 64
          ? (s = "W")
          : 64 > t && t >= 56
            ? (s = "V")
            : 56 > t && t >= 48
              ? (s = "U")
              : 48 > t && t >= 40
                ? (s = "T")
                : 40 > t && t >= 32
                  ? (s = "S")
                  : 32 > t && t >= 24
                    ? (s = "R")
                    : 24 > t && t >= 16
                      ? (s = "Q")
                      : 16 > t && t >= 8
                        ? (s = "P")
                        : 8 > t && t >= 0
                          ? (s = "N")
                          : 0 > t && t >= -8
                            ? (s = "M")
                            : -8 > t && t >= -16
                              ? (s = "L")
                              : -16 > t && t >= -24
                                ? (s = "K")
                                : -24 > t && t >= -32
                                  ? (s = "J")
                                  : -32 > t && t >= -40
                                    ? (s = "H")
                                    : -40 > t && t >= -48
                                      ? (s = "G")
                                      : -48 > t && t >= -56
                                        ? (s = "F")
                                        : -56 > t && t >= -64
                                          ? (s = "E")
                                          : -64 > t && t >= -72
                                            ? (s = "D")
                                            : -72 > t && t >= -80 && (s = "C"),
      s
    );
  }
  function $(t, s) {
    var i = "00000" + t.easting,
      a = "00000" + t.northing;
    return (
      t.zoneNumber +
      t.zoneLetter +
      tt(t.easting, t.northing, t.zoneNumber) +
      i.substr(i.length - 5, s) +
      a.substr(a.length - 5, s)
    );
  }
  function tt(t, s, i) {
    var a = st(i);
    return it(Math.floor(t / 1e5), Math.floor(s / 1e5) % 20, a);
  }
  function st(t) {
    var s = t % os;
    return 0 === s && (s = os), s;
  }
  function it(t, s, i) {
    var a = i - 1,
      h = ls.charCodeAt(a),
      e = us.charCodeAt(a),
      n = h + t - 1,
      r = e + s,
      o = !1;
    return (
      n > ps && ((n = n - ps + cs - 1), (o = !0)),
      (n === Ms || (h < Ms && n > Ms) || ((n > Ms || h < Ms) && o)) && n++,
      (n === fs || (h < fs && n > fs) || ((n > fs || h < fs) && o)) &&
        ++n === Ms &&
        n++,
      n > ps && (n = n - ps + cs - 1),
      r > ds ? ((r = r - ds + cs - 1), (o = !0)) : (o = !1),
      (r === Ms || (e < Ms && r > Ms) || ((r > Ms || e < Ms) && o)) && r++,
      (r === fs || (e < fs && r > fs) || ((r > fs || e < fs) && o)) &&
        ++r === Ms &&
        r++,
      r > ds && (r = r - ds + cs - 1),
      String.fromCharCode(n) + String.fromCharCode(r)
    );
  }
  function at(t) {
    if (t && 0 === t.length) throw "MGRSPoint coverting from nothing";
    for (
      var s, i = t.length, a = null, h = "", e = 0;
      !/[A-Z]/.test((s = t.charAt(e)));

    ) {
      if (e >= 2) throw "MGRSPoint bad conversion from: " + t;
      (h += s), e++;
    }
    var n = parseInt(h, 10);
    if (0 === e || e + 3 > i) throw "MGRSPoint bad conversion from: " + t;
    var r = t.charAt(e++);
    if (
      r <= "A" ||
      "B" === r ||
      "Y" === r ||
      r >= "Z" ||
      "I" === r ||
      "O" === r
    )
      throw "MGRSPoint zone letter " + r + " not handled: " + t;
    a = t.substring(e, (e += 2));
    for (
      var o = st(n), l = ht(a.charAt(0), o), u = et(a.charAt(1), o);
      u < nt(r);

    )
      u += 2e6;
    var c = i - e;
    if (c % 2 != 0)
      throw (
        "MGRSPoint has to have an even number \nof digits after the zone letter and two 100km letters - front \nhalf for easting meters, second half for \nnorthing meters" +
        t
      );
    var M,
      f,
      d,
      p,
      m,
      y = c / 2,
      _ = 0,
      x = 0;
    return (
      y > 0 &&
        ((M = 1e5 / Math.pow(10, y)),
        (f = t.substring(e, e + y)),
        (_ = parseFloat(f) * M),
        (d = t.substring(e + y)),
        (x = parseFloat(d) * M)),
      (p = _ + l),
      (m = x + u),
      { easting: p, northing: m, zoneLetter: r, zoneNumber: n, accuracy: M }
    );
  }
  function ht(t, s) {
    for (
      var i = ls.charCodeAt(s - 1), a = 1e5, h = !1;
      i !== t.charCodeAt(0);

    ) {
      if ((++i === Ms && i++, i === fs && i++, i > ps)) {
        if (h) throw "Bad character: " + t;
        (i = cs), (h = !0);
      }
      a += 1e5;
    }
    return a;
  }
  function et(t, s) {
    if (t > "V") throw "MGRSPoint given invalid Northing " + t;
    for (var i = us.charCodeAt(s - 1), a = 0, h = !1; i !== t.charCodeAt(0); ) {
      if ((++i === Ms && i++, i === fs && i++, i > ds)) {
        if (h) throw "Bad character: " + t;
        (i = cs), (h = !0);
      }
      a += 1e5;
    }
    return a;
  }
  function nt(t) {
    var s;
    switch (t) {
      case "C":
        s = 11e5;
        break;
      case "D":
        s = 2e6;
        break;
      case "E":
        s = 28e5;
        break;
      case "F":
        s = 37e5;
        break;
      case "G":
        s = 46e5;
        break;
      case "H":
        s = 55e5;
        break;
      case "J":
        s = 64e5;
        break;
      case "K":
        s = 73e5;
        break;
      case "L":
        s = 82e5;
        break;
      case "M":
        s = 91e5;
        break;
      case "N":
        s = 0;
        break;
      case "P":
        s = 8e5;
        break;
      case "Q":
        s = 17e5;
        break;
      case "R":
        s = 26e5;
        break;
      case "S":
        s = 35e5;
        break;
      case "T":
        s = 44e5;
        break;
      case "U":
        s = 53e5;
        break;
      case "V":
        s = 62e5;
        break;
      case "W":
        s = 7e6;
        break;
      case "X":
        s = 79e5;
        break;
      default:
        s = -1;
    }
    if (s >= 0) return s;
    throw "Invalid zone letter: " + t;
  }
  function Point(t, s, i) {
    if (!(this instanceof Point)) return new Point(t, s, i);
    if (Array.isArray(t))
      (this.x = t[0]), (this.y = t[1]), (this.z = t[2] || 0);
    else if ("object" == typeof t)
      (this.x = t.x), (this.y = t.y), (this.z = t.z || 0);
    else if ("string" == typeof t && void 0 === s) {
      var a = t.split(",");
      (this.x = parseFloat(a[0], 10)),
        (this.y = parseFloat(a[1], 10)),
        (this.z = parseFloat(a[2], 10) || 0);
    } else (this.x = t), (this.y = s), (this.z = i || 0);
    console.warn("proj4.Point will be removed in version 3, use proj4.toPoint");
  }
  function rt(t) {
    var s = [
        "Hotine_Oblique_Mercator",
        "Hotine_Oblique_Mercator_Azimuth_Natural_Origin",
      ],
      i =
        "object" == typeof t.PROJECTION
          ? Object.keys(t.PROJECTION)[0]
          : t.PROJECTION;
    return "no_uoff" in t || "no_off" in t || -1 !== s.indexOf(i);
  }
  function ot(t) {
    var s,
      i = [];
    return (
      (i[0] = t * $s),
      (s = t * t),
      (i[0] += s * ti),
      (i[1] = s * ii),
      (s *= t),
      (i[0] += s * si),
      (i[1] += s * ai),
      (i[2] = s * hi),
      i
    );
  }
  function lt(t, s) {
    var i = t + t;
    return (
      t +
      s[0] * Math.sin(i) +
      s[1] * Math.sin(i + i) +
      s[2] * Math.sin(i + i + i)
    );
  }
  function ut(t, s, i, a) {
    var h;
    return (
      t < wt
        ? ((a.value = Ni.AREA_0), (h = 0))
        : ((h = Math.atan2(s, i)),
          Math.abs(h) <= At
            ? (a.value = Ni.AREA_0)
            : h > At && h <= xt + At
              ? ((a.value = Ni.AREA_1), (h -= xt))
              : h > xt + At || h <= -(xt + At)
                ? ((a.value = Ni.AREA_2), (h = h >= 0 ? h - Pt : h + Pt))
                : ((a.value = Ni.AREA_3), (h += xt))),
      h
    );
  }
  function ct(t, s) {
    var i = t + s;
    return i < -Pt ? (i += Ct) : i > +Pt && (i -= Ct), i;
  }
  function Mt(t, s, i, a) {
    for (var h = s; a; --a) {
      var e = t(h);
      if (((h -= e), Math.abs(e) < i)) break;
    }
    return h;
  }
  var ft = 1,
    dt = 2,
    pt = 3,
    mt = 4,
    yt = 5,
    _t = 484813681109536e-20,
    xt = Math.PI / 2,
    gt = 0.16666666666666666,
    vt = 0.04722222222222222,
    bt = 0.022156084656084655,
    wt = 1e-10,
    Nt = 0.017453292519943295,
    Et = 57.29577951308232,
    At = Math.PI / 4,
    Ct = 2 * Math.PI,
    Pt = 3.14159265359,
    St = {};
  (St.greenwich = 0),
    (St.lisbon = -9.131906111111),
    (St.paris = 2.337229166667),
    (St.bogota = -74.080916666667),
    (St.madrid = -3.687938888889),
    (St.rome = 12.452333333333),
    (St.bern = 7.439583333333),
    (St.jakarta = 106.807719444444),
    (St.ferro = -17.666666666667),
    (St.brussels = 4.367975),
    (St.stockholm = 18.058277777778),
    (St.athens = 23.7163375),
    (St.oslo = 10.722916666667);
  var It = { ft: { to_meter: 0.3048 }, "us-ft": { to_meter: 1200 / 3937 } },
    Ot = /[\s_\-\/\(\)]/g,
    kt = function (s) {
      var i,
        a,
        h,
        e = {},
        n = s
          .split("+")
          .map(function (t) {
            return t.trim();
          })
          .filter(function (t) {
            return t;
          })
          .reduce(function (t, s) {
            var i = s.split("=");
            return i.push(!0), (t[i[0].toLowerCase()] = i[1]), t;
          }, {}),
        r = {
          proj: "projName",
          datum: "datumCode",
          rf: function (t) {
            e.rf = parseFloat(t);
          },
          lat_0: function (t) {
            e.lat0 = t * Nt;
          },
          lat_1: function (t) {
            e.lat1 = t * Nt;
          },
          lat_2: function (t) {
            e.lat2 = t * Nt;
          },
          lat_ts: function (t) {
            e.lat_ts = t * Nt;
          },
          lon_0: function (t) {
            e.long0 = t * Nt;
          },
          lon_1: function (t) {
            e.long1 = t * Nt;
          },
          lon_2: function (t) {
            e.long2 = t * Nt;
          },
          alpha: function (t) {
            e.alpha = parseFloat(t) * Nt;
          },
          gamma: function (t) {
            e.rectified_grid_angle = parseFloat(t);
          },
          lonc: function (t) {
            e.longc = t * Nt;
          },
          x_0: function (t) {
            e.x0 = parseFloat(t);
          },
          y_0: function (t) {
            e.y0 = parseFloat(t);
          },
          k_0: function (t) {
            e.k0 = parseFloat(t);
          },
          k: function (t) {
            e.k0 = parseFloat(t);
          },
          a: function (t) {
            e.a = parseFloat(t);
          },
          b: function (t) {
            e.b = parseFloat(t);
          },
          r: function (t) {
            e.a = e.b = parseFloat(t);
          },
          r_a: function () {
            e.R_A = !0;
          },
          zone: function (t) {
            e.zone = parseInt(t, 10);
          },
          south: function () {
            e.utmSouth = !0;
          },
          towgs84: function (t) {
            e.datum_params = t.split(",").map(function (t) {
              return parseFloat(t);
            });
          },
          to_meter: function (t) {
            e.to_meter = parseFloat(t);
          },
          units: function (s) {
            e.units = s;
            var i = t(It, s);
            i && (e.to_meter = i.to_meter);
          },
          from_greenwich: function (t) {
            e.from_greenwich = t * Nt;
          },
          pm: function (s) {
            var i = t(St, s);
            e.from_greenwich = (i || parseFloat(s)) * Nt;
          },
          nadgrids: function (t) {
            "@null" === t ? (e.datumCode = "none") : (e.nadgrids = t);
          },
          axis: function (t) {
            3 === t.length &&
              -1 !== "ewnsud".indexOf(t.substr(0, 1)) &&
              -1 !== "ewnsud".indexOf(t.substr(1, 1)) &&
              -1 !== "ewnsud".indexOf(t.substr(2, 1)) &&
              (e.axis = t);
          },
          approx: function () {
            e.approx = !0;
          },
        };
      for (i in n)
        (a = n[i]),
          i in r
            ? "function" == typeof (h = r[i])
              ? h(a)
              : (e[h] = a)
            : (e[i] = a);
      return (
        "string" == typeof e.datumCode &&
          "WGS84" !== e.datumCode &&
          (e.datumCode = e.datumCode.toLowerCase()),
        e
      );
    },
    qt = 1,
    Rt = /\s/,
    Lt = /[A-Za-z]/,
    Gt = /[A-Za-z84_]/,
    Tt = /[,\]]/,
    jt = /[\d\.E\-\+]/;
  (s.prototype.readCharicter = function () {
    var t = this.text[this.place++];
    if (4 !== this.state)
      for (; Rt.test(t); ) {
        if (this.place >= this.text.length) return;
        t = this.text[this.place++];
      }
    switch (this.state) {
      case qt:
        return this.neutral(t);
      case 2:
        return this.keyword(t);
      case 4:
        return this.quoted(t);
      case 5:
        return this.afterquote(t);
      case 3:
        return this.number(t);
      case -1:
        return;
    }
  }),
    (s.prototype.afterquote = function (t) {
      if ('"' === t) return (this.word += '"'), void (this.state = 4);
      if (Tt.test(t))
        return (this.word = this.word.trim()), void this.afterItem(t);
      throw new Error(
        "havn't handled \"" + t + '" in afterquote yet, index ' + this.place,
      );
    }),
    (s.prototype.afterItem = function (t) {
      return "," === t
        ? (null !== this.word && this.currentObject.push(this.word),
          (this.word = null),
          void (this.state = qt))
        : "]" === t
          ? (this.level--,
            null !== this.word &&
              (this.currentObject.push(this.word), (this.word = null)),
            (this.state = qt),
            (this.currentObject = this.stack.pop()),
            void (this.currentObject || (this.state = -1)))
          : void 0;
    }),
    (s.prototype.number = function (t) {
      if (!jt.test(t)) {
        if (Tt.test(t))
          return (this.word = parseFloat(this.word)), void this.afterItem(t);
        throw new Error(
          "havn't handled \"" + t + '" in number yet, index ' + this.place,
        );
      }
      this.word += t;
    }),
    (s.prototype.quoted = function (t) {
      '"' !== t ? (this.word += t) : (this.state = 5);
    }),
    (s.prototype.keyword = function (t) {
      if (Gt.test(t)) this.word += t;
      else {
        if ("[" === t) {
          var s = [];
          return (
            s.push(this.word),
            this.level++,
            null === this.root ? (this.root = s) : this.currentObject.push(s),
            this.stack.push(this.currentObject),
            (this.currentObject = s),
            void (this.state = qt)
          );
        }
        if (!Tt.test(t))
          throw new Error(
            "havn't handled \"" + t + '" in keyword yet, index ' + this.place,
          );
        this.afterItem(t);
      }
    }),
    (s.prototype.neutral = function (t) {
      if (Lt.test(t)) return (this.word = t), void (this.state = 2);
      if ('"' === t) return (this.word = ""), void (this.state = 4);
      if (jt.test(t)) return (this.word = t), void (this.state = 3);
      {
        if (!Tt.test(t))
          throw new Error(
            "havn't handled \"" + t + '" in neutral yet, index ' + this.place,
          );
        this.afterItem(t);
      }
    }),
    (s.prototype.output = function () {
      for (; this.place < this.text.length; ) this.readCharicter();
      if (-1 === this.state) return this.root;
      throw new Error(
        'unable to parse string "' + this.text + '". State is ' + this.state,
      );
    });
  var Bt = 0.017453292519943295,
    zt = function (t) {
      var s = i(t),
        a = s.shift(),
        e = s.shift();
      s.unshift(["name", e]), s.unshift(["type", a]);
      var n = {};
      return h(s, n), r(n), n;
    };
  !(function (t) {
    t(
      "EPSG:4326",
      "+title=WGS 84 (long/lat) +proj=longlat +ellps=WGS84 +datum=WGS84 +units=degrees",
    ),
      t(
        "EPSG:4269",
        "+title=NAD83 (long/lat) +proj=longlat +a=6378137.0 +b=6356752.31414036 +ellps=GRS80 +datum=NAD83 +units=degrees",
      ),
      t(
        "EPSG:3857",
        "+title=WGS 84 / Pseudo-Mercator +proj=merc +a=6378137 +b=6378137 +lat_ts=0.0 +lon_0=0.0 +x_0=0.0 +y_0=0 +k=1.0 +units=m +nadgrids=@null +no_defs",
      ),
      (t.WGS84 = t["EPSG:4326"]),
      (t["EPSG:3785"] = t["EPSG:3857"]),
      (t.GOOGLE = t["EPSG:3857"]),
      (t["EPSG:900913"] = t["EPSG:3857"]),
      (t["EPSG:102113"] = t["EPSG:3857"]);
  })(o);
  var Ft = [
      "PROJECTEDCRS",
      "PROJCRS",
      "GEOGCS",
      "GEOCCS",
      "PROJCS",
      "LOCAL_CS",
      "GEODCRS",
      "GEODETICCRS",
      "GEODETICDATUM",
      "ENGCRS",
      "ENGINEERINGCRS",
    ],
    Dt = ["3857", "900913", "3785", "102113"],
    Ut = function (t, s) {
      t = t || {};
      var i, a;
      if (!s) return t;
      for (a in s) void 0 !== (i = s[a]) && (t[a] = i);
      return t;
    },
    Qt = function (t, s, i) {
      var a = t * s;
      return i / Math.sqrt(1 - a * a);
    },
    Wt = function (t) {
      return t < 0 ? -1 : 1;
    },
    Ht = function (t) {
      return Math.abs(t) <= Pt ? t : t - Wt(t) * Ct;
    },
    Xt = function (t, s, i) {
      var a = t * i,
        h = 0.5 * t;
      return (a = Math.pow((1 - a) / (1 + a), h)), Math.tan(0.5 * (xt - s)) / a;
    },
    Kt = function (t, s) {
      for (
        var i, a, h = 0.5 * t, e = xt - 2 * Math.atan(s), n = 0;
        n <= 15;
        n++
      )
        if (
          ((i = t * Math.sin(e)),
          (a = xt - 2 * Math.atan(s * Math.pow((1 - i) / (1 + i), h)) - e),
          (e += a),
          Math.abs(a) <= 1e-10)
        )
          return e;
      return -9999;
    },
    Jt = [
      {
        init: function () {
          var t = this.b / this.a;
          (this.es = 1 - t * t),
            "x0" in this || (this.x0 = 0),
            "y0" in this || (this.y0 = 0),
            (this.e = Math.sqrt(this.es)),
            this.lat_ts
              ? this.sphere
                ? (this.k0 = Math.cos(this.lat_ts))
                : (this.k0 = Qt(
                    this.e,
                    Math.sin(this.lat_ts),
                    Math.cos(this.lat_ts),
                  ))
              : this.k0 || (this.k ? (this.k0 = this.k) : (this.k0 = 1));
        },
        forward: function (t) {
          var s = t.x,
            i = t.y;
          if (i * Et > 90 && i * Et < -90 && s * Et > 180 && s * Et < -180)
            return null;
          var a, h;
          if (Math.abs(Math.abs(i) - xt) <= wt) return null;
          if (this.sphere)
            (a = this.x0 + this.a * this.k0 * Ht(s - this.long0)),
              (h =
                this.y0 + this.a * this.k0 * Math.log(Math.tan(At + 0.5 * i)));
          else {
            var e = Math.sin(i),
              n = Xt(this.e, i, e);
            (a = this.x0 + this.a * this.k0 * Ht(s - this.long0)),
              (h = this.y0 - this.a * this.k0 * Math.log(n));
          }
          return (t.x = a), (t.y = h), t;
        },
        inverse: function (t) {
          var s,
            i,
            a = t.x - this.x0,
            h = t.y - this.y0;
          if (this.sphere)
            i = xt - 2 * Math.atan(Math.exp(-h / (this.a * this.k0)));
          else {
            var e = Math.exp(-h / (this.a * this.k0));
            if (-9999 === (i = Kt(this.e, e))) return null;
          }
          return (
            (s = Ht(this.long0 + a / (this.a * this.k0))),
            (t.x = s),
            (t.y = i),
            t
          );
        },
        names: [
          "Mercator",
          "Popular Visualisation Pseudo Mercator",
          "Mercator_1SP",
          "Mercator_Auxiliary_Sphere",
          "merc",
        ],
      },
      {
        init: function () {},
        forward: m,
        inverse: m,
        names: ["longlat", "identity"],
      },
    ],
    Vt = {},
    Zt = [],
    Yt = {
      start: function () {
        Jt.forEach(y);
      },
      add: y,
      get: function (t) {
        if (!t) return !1;
        var s = t.toLowerCase();
        return void 0 !== Vt[s] && Zt[Vt[s]] ? Zt[Vt[s]] : void 0;
      },
    },
    $t = {};
  ($t.MERIT = { a: 6378137, rf: 298.257, ellipseName: "MERIT 1983" }),
    ($t.SGS85 = {
      a: 6378136,
      rf: 298.257,
      ellipseName: "Soviet Geodetic System 85",
    }),
    ($t.GRS80 = {
      a: 6378137,
      rf: 298.257222101,
      ellipseName: "GRS 1980(IUGG, 1980)",
    }),
    ($t.IAU76 = { a: 6378140, rf: 298.257, ellipseName: "IAU 1976" }),
    ($t.airy = { a: 6377563.396, b: 6356256.91, ellipseName: "Airy 1830" }),
    ($t.APL4 = { a: 6378137, rf: 298.25, ellipseName: "Appl. Physics. 1965" }),
    ($t.NWL9D = {
      a: 6378145,
      rf: 298.25,
      ellipseName: "Naval Weapons Lab., 1965",
    }),
    ($t.mod_airy = {
      a: 6377340.189,
      b: 6356034.446,
      ellipseName: "Modified Airy",
    }),
    ($t.andrae = {
      a: 6377104.43,
      rf: 300,
      ellipseName: "Andrae 1876 (Den., Iclnd.)",
    }),
    ($t.aust_SA = {
      a: 6378160,
      rf: 298.25,
      ellipseName: "Australian Natl & S. Amer. 1969",
    }),
    ($t.GRS67 = {
      a: 6378160,
      rf: 298.247167427,
      ellipseName: "GRS 67(IUGG 1967)",
    }),
    ($t.bessel = {
      a: 6377397.155,
      rf: 299.1528128,
      ellipseName: "Bessel 1841",
    }),
    ($t.bess_nam = {
      a: 6377483.865,
      rf: 299.1528128,
      ellipseName: "Bessel 1841 (Namibia)",
    }),
    ($t.clrk66 = { a: 6378206.4, b: 6356583.8, ellipseName: "Clarke 1866" }),
    ($t.clrk80 = {
      a: 6378249.145,
      rf: 293.4663,
      ellipseName: "Clarke 1880 mod.",
    }),
    ($t.clrk80ign = {
      a: 6378249.2,
      b: 6356515,
      rf: 293.4660213,
      ellipseName: "Clarke 1880 (IGN)",
    }),
    ($t.clrk58 = {
      a: 6378293.645208759,
      rf: 294.2606763692654,
      ellipseName: "Clarke 1858",
    }),
    ($t.CPM = {
      a: 6375738.7,
      rf: 334.29,
      ellipseName: "Comm. des Poids et Mesures 1799",
    }),
    ($t.delmbr = {
      a: 6376428,
      rf: 311.5,
      ellipseName: "Delambre 1810 (Belgium)",
    }),
    ($t.engelis = { a: 6378136.05, rf: 298.2566, ellipseName: "Engelis 1985" }),
    ($t.evrst30 = {
      a: 6377276.345,
      rf: 300.8017,
      ellipseName: "Everest 1830",
    }),
    ($t.evrst48 = {
      a: 6377304.063,
      rf: 300.8017,
      ellipseName: "Everest 1948",
    }),
    ($t.evrst56 = {
      a: 6377301.243,
      rf: 300.8017,
      ellipseName: "Everest 1956",
    }),
    ($t.evrst69 = {
      a: 6377295.664,
      rf: 300.8017,
      ellipseName: "Everest 1969",
    }),
    ($t.evrstSS = {
      a: 6377298.556,
      rf: 300.8017,
      ellipseName: "Everest (Sabah & Sarawak)",
    }),
    ($t.fschr60 = {
      a: 6378166,
      rf: 298.3,
      ellipseName: "Fischer (Mercury Datum) 1960",
    }),
    ($t.fschr60m = { a: 6378155, rf: 298.3, ellipseName: "Fischer 1960" }),
    ($t.fschr68 = { a: 6378150, rf: 298.3, ellipseName: "Fischer 1968" }),
    ($t.helmert = { a: 6378200, rf: 298.3, ellipseName: "Helmert 1906" }),
    ($t.hough = { a: 6378270, rf: 297, ellipseName: "Hough" }),
    ($t.intl = {
      a: 6378388,
      rf: 297,
      ellipseName: "International 1909 (Hayford)",
    }),
    ($t.kaula = { a: 6378163, rf: 298.24, ellipseName: "Kaula 1961" }),
    ($t.lerch = { a: 6378139, rf: 298.257, ellipseName: "Lerch 1979" }),
    ($t.mprts = { a: 6397300, rf: 191, ellipseName: "Maupertius 1738" }),
    ($t.new_intl = {
      a: 6378157.5,
      b: 6356772.2,
      ellipseName: "New International 1967",
    }),
    ($t.plessis = {
      a: 6376523,
      rf: 6355863,
      ellipseName: "Plessis 1817 (France)",
    }),
    ($t.krass = { a: 6378245, rf: 298.3, ellipseName: "Krassovsky, 1942" }),
    ($t.SEasia = {
      a: 6378155,
      b: 6356773.3205,
      ellipseName: "Southeast Asia",
    }),
    ($t.walbeck = { a: 6376896, b: 6355834.8467, ellipseName: "Walbeck" }),
    ($t.WGS60 = { a: 6378165, rf: 298.3, ellipseName: "WGS 60" }),
    ($t.WGS66 = { a: 6378145, rf: 298.25, ellipseName: "WGS 66" }),
    ($t.WGS7 = { a: 6378135, rf: 298.26, ellipseName: "WGS 72" });
  var ts = ($t.WGS84 = {
    a: 6378137,
    rf: 298.257223563,
    ellipseName: "WGS 84",
  });
  $t.sphere = {
    a: 6370997,
    b: 6370997,
    ellipseName: "Normal Sphere (r=6370997)",
  };
  var ss = {};
  (ss.wgs84 = { towgs84: "0,0,0", ellipse: "WGS84", datumName: "WGS84" }),
    (ss.ch1903 = {
      towgs84: "674.374,15.056,405.346",
      ellipse: "bessel",
      datumName: "swiss",
    }),
    (ss.ggrs87 = {
      towgs84: "-199.87,74.79,246.62",
      ellipse: "GRS80",
      datumName: "Greek_Geodetic_Reference_System_1987",
    }),
    (ss.nad83 = {
      towgs84: "0,0,0",
      ellipse: "GRS80",
      datumName: "North_American_Datum_1983",
    }),
    (ss.nad27 = {
      nadgrids: "@conus,@alaska,@ntv2_0.gsb,@ntv1_can.dat",
      ellipse: "clrk66",
      datumName: "North_American_Datum_1927",
    }),
    (ss.potsdam = {
      towgs84: "598.1,73.7,418.2,0.202,0.045,-2.455,6.7",
      ellipse: "bessel",
      datumName: "Potsdam Rauenberg 1950 DHDN",
    }),
    (ss.carthage = {
      towgs84: "-263.0,6.0,431.0",
      ellipse: "clark80",
      datumName: "Carthage 1934 Tunisia",
    }),
    (ss.hermannskogel = {
      towgs84: "577.326,90.129,463.919,5.137,1.474,5.297,2.4232",
      ellipse: "bessel",
      datumName: "Hermannskogel",
    }),
    (ss.militargeographische_institut = {
      towgs84: "577.326,90.129,463.919,5.137,1.474,5.297,2.4232",
      ellipse: "bessel",
      datumName: "Militar-Geographische Institut",
    }),
    (ss.osni52 = {
      towgs84: "482.530,-130.596,564.557,-1.042,-0.214,-0.631,8.15",
      ellipse: "airy",
      datumName: "Irish National",
    }),
    (ss.ire65 = {
      towgs84: "482.530,-130.596,564.557,-1.042,-0.214,-0.631,8.15",
      ellipse: "mod_airy",
      datumName: "Ireland 1965",
    }),
    (ss.rassadiran = {
      towgs84: "-133.63,-157.5,-158.62",
      ellipse: "intl",
      datumName: "Rassadiran",
    }),
    (ss.nzgd49 = {
      towgs84: "59.47,-5.04,187.44,0.47,-0.1,1.024,-4.5993",
      ellipse: "intl",
      datumName: "New Zealand Geodetic Datum 1949",
    }),
    (ss.osgb36 = {
      towgs84: "446.448,-125.157,542.060,0.1502,0.2470,0.8421,-20.4894",
      ellipse: "airy",
      datumName: "Airy 1830",
    }),
    (ss.s_jtsk = {
      towgs84: "589,76,480",
      ellipse: "bessel",
      datumName: "S-JTSK (Ferro)",
    }),
    (ss.beduaram = {
      towgs84: "-106,-87,188",
      ellipse: "clrk80",
      datumName: "Beduaram",
    }),
    (ss.gunung_segara = {
      towgs84: "-403,684,41",
      ellipse: "bessel",
      datumName: "Gunung Segara Jakarta",
    }),
    (ss.rnb72 = {
      towgs84: "106.869,-52.2978,103.724,-0.33657,0.456955,-1.84218,1",
      ellipse: "intl",
      datumName: "Reseau National Belge 1972",
    });
  var is = {};
  (Projection.projections = Yt), Projection.projections.start();
  var as = function (t, s, i) {
      if (O(t, s)) return i;
      if (t.datum_type === yt || s.datum_type === yt) return i;
      var a = t.a,
        h = t.es;
      if (t.datum_type === pt) {
        if (0 !== T(t, !1, i)) return;
        (a = 6378137), (h = 0.0066943799901413165);
      }
      var e = s.a,
        n = s.b,
        r = s.es;
      return (
        s.datum_type === pt &&
          ((e = 6378137), (n = 6356752.314), (r = 0.0066943799901413165)),
        h !== r || a !== e || G(t.datum_type) || G(s.datum_type)
          ? ((i = k(i, h, a)),
            G(t.datum_type) && (i = R(i, t.datum_type, t.datum_params)),
            G(s.datum_type) && (i = L(i, s.datum_type, s.datum_params)),
            (i = q(i, r, e, n)),
            s.datum_type !== pt || 0 === T(s, !0, i) ? i : void 0)
          : i
      );
    },
    hs = function (t, s, i) {
      var a,
        h,
        e,
        n = i.x,
        r = i.y,
        o = i.z || 0,
        l = {};
      for (e = 0; e < 3; e++)
        if (!s || 2 !== e || void 0 !== i.z)
          switch (
            (0 === e
              ? ((a = n), (h = -1 !== "ew".indexOf(t.axis[e]) ? "x" : "y"))
              : 1 === e
                ? ((a = r), (h = -1 !== "ns".indexOf(t.axis[e]) ? "y" : "x"))
                : ((a = o), (h = "z")),
            t.axis[e])
          ) {
            case "e":
              l[h] = a;
              break;
            case "w":
              l[h] = -a;
              break;
            case "n":
              l[h] = a;
              break;
            case "s":
              l[h] = -a;
              break;
            case "u":
              void 0 !== i[h] && (l.z = a);
              break;
            case "d":
              void 0 !== i[h] && (l.z = -a);
              break;
            default:
              return null;
          }
      return l;
    },
    es = function (t) {
      var s = { x: t[0], y: t[1] };
      return t.length > 2 && (s.z = t[2]), t.length > 3 && (s.m = t[3]), s;
    },
    ns = function (t) {
      z(t.x), z(t.y);
    },
    rs = Projection("WGS84"),
    os = 6,
    ls = "AJSAJS",
    us = "AFAFAF",
    cs = 65,
    Ms = 73,
    fs = 79,
    ds = 86,
    ps = 90,
    ms = {
      forward: H,
      inverse: function (t) {
        var s = Z(at(t.toUpperCase()));
        return s.lat && s.lon
          ? [s.lon, s.lat, s.lon, s.lat]
          : [s.left, s.bottom, s.right, s.top];
      },
      toPoint: X,
    };
  (Point.fromMGRS = function (t) {
    return new Point(X(t));
  }),
    (Point.prototype.toMGRS = function (t) {
      return H([this.x, this.y], t);
    });
  var ys = 0.01068115234375,
    _s = function (t) {
      var s = [];
      (s[0] = 1 - t * (0.25 + t * (0.046875 + t * (0.01953125 + t * ys)))),
        (s[1] = t * (0.75 - t * (0.046875 + t * (0.01953125 + t * ys))));
      var i = t * t;
      return (
        (s[2] =
          i *
          (0.46875 - t * (0.013020833333333334 + 0.007120768229166667 * t))),
        (i *= t),
        (s[3] = i * (0.3645833333333333 - 0.005696614583333333 * t)),
        (s[4] = i * t * 0.3076171875),
        s
      );
    },
    xs = function (t, s, i, a) {
      return (
        (i *= s),
        (s *= s),
        a[0] * t - i * (a[1] + s * (a[2] + s * (a[3] + s * a[4])))
      );
    },
    gs = function (t, s, i) {
      for (var a = 1 / (1 - s), h = t, e = 20; e; --e) {
        var n = Math.sin(h),
          r = 1 - s * n * n;
        if (
          ((r = (xs(h, n, Math.cos(h), i) - t) * (r * Math.sqrt(r)) * a),
          (h -= r),
          Math.abs(r) < wt)
        )
          return h;
      }
      return h;
    },
    vs = {
      init: function () {
        (this.x0 = void 0 !== this.x0 ? this.x0 : 0),
          (this.y0 = void 0 !== this.y0 ? this.y0 : 0),
          (this.long0 = void 0 !== this.long0 ? this.long0 : 0),
          (this.lat0 = void 0 !== this.lat0 ? this.lat0 : 0),
          this.es &&
            ((this.en = _s(this.es)),
            (this.ml0 = xs(
              this.lat0,
              Math.sin(this.lat0),
              Math.cos(this.lat0),
              this.en,
            )));
      },
      forward: function (t) {
        var s,
          i,
          a,
          h = t.x,
          e = t.y,
          n = Ht(h - this.long0),
          r = Math.sin(e),
          o = Math.cos(e);
        if (this.es) {
          var l = o * n,
            u = Math.pow(l, 2),
            c = this.ep2 * Math.pow(o, 2),
            M = Math.pow(c, 2),
            f = Math.abs(o) > wt ? Math.tan(e) : 0,
            d = Math.pow(f, 2),
            p = Math.pow(d, 2);
          (s = 1 - this.es * Math.pow(r, 2)), (l /= Math.sqrt(s));
          var m = xs(e, r, o, this.en);
          (i =
            this.a *
              (this.k0 *
                l *
                (1 +
                  (u / 6) *
                    (1 -
                      d +
                      c +
                      (u / 20) *
                        (5 -
                          18 * d +
                          p +
                          14 * c -
                          58 * d * c +
                          (u / 42) * (61 + 179 * p - p * d - 479 * d))))) +
            this.x0),
            (a =
              this.a *
                (this.k0 *
                  (m -
                    this.ml0 +
                    ((r * n * l) / 2) *
                      (1 +
                        (u / 12) *
                          (5 -
                            d +
                            9 * c +
                            4 * M +
                            (u / 30) *
                              (61 +
                                p -
                                58 * d +
                                270 * c -
                                330 * d * c +
                                (u / 56) *
                                  (1385 + 543 * p - p * d - 3111 * d)))))) +
              this.y0);
        } else {
          var y = o * Math.sin(n);
          if (Math.abs(Math.abs(y) - 1) < wt) return 93;
          if (
            ((i =
              0.5 * this.a * this.k0 * Math.log((1 + y) / (1 - y)) + this.x0),
            (a = (o * Math.cos(n)) / Math.sqrt(1 - Math.pow(y, 2))),
            (y = Math.abs(a)) >= 1)
          ) {
            if (y - 1 > wt) return 93;
            a = 0;
          } else a = Math.acos(a);
          e < 0 && (a = -a), (a = this.a * this.k0 * (a - this.lat0) + this.y0);
        }
        return (t.x = i), (t.y = a), t;
      },
      inverse: function (t) {
        var s,
          i,
          a,
          h,
          e = (t.x - this.x0) * (1 / this.a),
          n = (t.y - this.y0) * (1 / this.a);
        if (this.es)
          if (
            ((s = this.ml0 + n / this.k0),
            (i = gs(s, this.es, this.en)),
            Math.abs(i) < xt)
          ) {
            var r = Math.sin(i),
              o = Math.cos(i),
              l = Math.abs(o) > wt ? Math.tan(i) : 0,
              u = this.ep2 * Math.pow(o, 2),
              c = Math.pow(u, 2),
              M = Math.pow(l, 2),
              f = Math.pow(M, 2);
            s = 1 - this.es * Math.pow(r, 2);
            var d = (e * Math.sqrt(s)) / this.k0,
              p = Math.pow(d, 2);
            (a =
              i -
              (((s *= l) * p) / (1 - this.es)) *
                0.5 *
                (1 -
                  (p / 12) *
                    (5 +
                      3 * M -
                      9 * u * M +
                      u -
                      4 * c -
                      (p / 30) *
                        (61 +
                          90 * M -
                          252 * u * M +
                          45 * f +
                          46 * u -
                          (p / 56) *
                            (1385 + 3633 * M + 4095 * f + 1574 * f * M))))),
              (h = Ht(
                this.long0 +
                  (d *
                    (1 -
                      (p / 6) *
                        (1 +
                          2 * M +
                          u -
                          (p / 20) *
                            (5 +
                              28 * M +
                              24 * f +
                              8 * u * M +
                              6 * u -
                              (p / 42) *
                                (61 + 662 * M + 1320 * f + 720 * f * M))))) /
                    o,
              ));
          } else (a = xt * Wt(n)), (h = 0);
        else {
          var m = Math.exp(e / this.k0),
            y = 0.5 * (m - 1 / m),
            _ = this.lat0 + n / this.k0,
            x = Math.cos(_);
          (s = Math.sqrt((1 - Math.pow(x, 2)) / (1 + Math.pow(y, 2)))),
            (a = Math.asin(s)),
            n < 0 && (a = -a),
            (h = 0 === y && 0 === x ? 0 : Ht(Math.atan2(y, x) + this.long0));
        }
        return (t.x = h), (t.y = a), t;
      },
      names: ["Fast_Transverse_Mercator", "Fast Transverse Mercator"],
    },
    bs = function (t) {
      var s = Math.exp(t);
      return (s = (s - 1 / s) / 2);
    },
    ws = function (t, s) {
      (t = Math.abs(t)), (s = Math.abs(s));
      var i = Math.max(t, s),
        a = Math.min(t, s) / (i || 1);
      return i * Math.sqrt(1 + Math.pow(a, 2));
    },
    Ns = function (t) {
      var s = 1 + t,
        i = s - 1;
      return 0 === i ? t : (t * Math.log(s)) / i;
    },
    Es = function (t) {
      var s = Math.abs(t);
      return (s = Ns(s * (1 + s / (ws(1, s) + 1)))), t < 0 ? -s : s;
    },
    As = function (t, s) {
      for (
        var i, a = 2 * Math.cos(2 * s), h = t.length - 1, e = t[h], n = 0;
        --h >= 0;

      )
        (i = a * e - n + t[h]), (n = e), (e = i);
      return s + i * Math.sin(2 * s);
    },
    Cs = function (t, s) {
      for (
        var i, a = 2 * Math.cos(s), h = t.length - 1, e = t[h], n = 0;
        --h >= 0;

      )
        (i = a * e - n + t[h]), (n = e), (e = i);
      return Math.sin(s) * i;
    },
    Ps = function (t) {
      var s = Math.exp(t);
      return (s = (s + 1 / s) / 2);
    },
    Ss = function (t, s, i) {
      for (
        var a,
          h,
          e = Math.sin(s),
          n = Math.cos(s),
          r = bs(i),
          o = Ps(i),
          l = 2 * n * o,
          u = -2 * e * r,
          c = t.length - 1,
          M = t[c],
          f = 0,
          d = 0,
          p = 0;
        --c >= 0;

      )
        (a = d),
          (h = f),
          (M = l * (d = M) - a - u * (f = p) + t[c]),
          (p = u * d - h + l * f);
      return (l = e * o), (u = n * r), [l * M - u * p, l * p + u * M];
    },
    Is = {
      init: function () {
        if (!this.approx && (isNaN(this.es) || this.es <= 0))
          throw new Error(
            'Incorrect elliptical usage. Try using the +approx option in the proj string, or PROJECTION["Fast_Transverse_Mercator"] in the WKT.',
          );
        this.approx &&
          (vs.init.apply(this),
          (this.forward = vs.forward),
          (this.inverse = vs.inverse)),
          (this.x0 = void 0 !== this.x0 ? this.x0 : 0),
          (this.y0 = void 0 !== this.y0 ? this.y0 : 0),
          (this.long0 = void 0 !== this.long0 ? this.long0 : 0),
          (this.lat0 = void 0 !== this.lat0 ? this.lat0 : 0),
          (this.cgb = []),
          (this.cbg = []),
          (this.utg = []),
          (this.gtu = []);
        var t = this.es / (1 + Math.sqrt(1 - this.es)),
          s = t / (2 - t),
          i = s;
        (this.cgb[0] =
          s *
          (2 +
            s *
              (-2 / 3 +
                s * (s * (116 / 45 + s * (26 / 45 + s * (-2854 / 675))) - 2)))),
          (this.cbg[0] =
            s *
            (s *
              (2 / 3 +
                s *
                  (4 / 3 +
                    s * (-82 / 45 + s * (32 / 45 + s * (4642 / 4725))))) -
              2)),
          (i *= s),
          (this.cgb[1] =
            i *
            (7 / 3 +
              s *
                (s * (-227 / 45 + s * (2704 / 315 + s * (2323 / 945))) - 1.6))),
          (this.cbg[1] =
            i *
            (5 / 3 +
              s *
                (-16 / 15 +
                  s * (-13 / 9 + s * (904 / 315 + s * (-1522 / 945)))))),
          (i *= s),
          (this.cgb[2] =
            i *
            (56 / 15 +
              s * (-136 / 35 + s * (-1262 / 105 + s * (73814 / 2835))))),
          (this.cbg[2] =
            i * (-26 / 15 + s * (34 / 21 + s * (1.6 + s * (-12686 / 2835))))),
          (i *= s),
          (this.cgb[3] =
            i * (4279 / 630 + s * (-332 / 35 + s * (-399572 / 14175)))),
          (this.cbg[3] = i * (1237 / 630 + s * (s * (-24832 / 14175) - 2.4))),
          (i *= s),
          (this.cgb[4] = i * (4174 / 315 + s * (-144838 / 6237))),
          (this.cbg[4] = i * (-734 / 315 + s * (109598 / 31185))),
          (i *= s),
          (this.cgb[5] = i * (601676 / 22275)),
          (this.cbg[5] = i * (444337 / 155925)),
          (i = Math.pow(s, 2)),
          (this.Qn =
            (this.k0 / (1 + s)) * (1 + i * (0.25 + i * (1 / 64 + i / 256)))),
          (this.utg[0] =
            s *
            (s *
              (2 / 3 +
                s *
                  (-37 / 96 +
                    s * (1 / 360 + s * (81 / 512 + s * (-96199 / 604800))))) -
              0.5)),
          (this.gtu[0] =
            s *
            (0.5 +
              s *
                (-2 / 3 +
                  s *
                    (5 / 16 +
                      s *
                        (41 / 180 + s * (-127 / 288 + s * (7891 / 37800))))))),
          (this.utg[1] =
            i *
            (-1 / 48 +
              s *
                (-1 / 15 +
                  s *
                    (437 / 1440 + s * (-46 / 105 + s * (1118711 / 3870720)))))),
          (this.gtu[1] =
            i *
            (13 / 48 +
              s *
                (s * (557 / 1440 + s * (281 / 630 + s * (-1983433 / 1935360))) -
                  0.6))),
          (i *= s),
          (this.utg[2] =
            i *
            (-17 / 480 +
              s * (37 / 840 + s * (209 / 4480 + s * (-5569 / 90720))))),
          (this.gtu[2] =
            i *
            (61 / 240 +
              s * (-103 / 140 + s * (15061 / 26880 + s * (167603 / 181440))))),
          (i *= s),
          (this.utg[3] =
            i * (-4397 / 161280 + s * (11 / 504 + s * (830251 / 7257600)))),
          (this.gtu[3] =
            i * (49561 / 161280 + s * (-179 / 168 + s * (6601661 / 7257600)))),
          (i *= s),
          (this.utg[4] = i * (-4583 / 161280 + s * (108847 / 3991680))),
          (this.gtu[4] = i * (34729 / 80640 + s * (-3418889 / 1995840))),
          (i *= s),
          (this.utg[5] = -0.03233083094085698 * i),
          (this.gtu[5] = 0.6650675310896665 * i);
        var a = As(this.cbg, this.lat0);
        this.Zb = -this.Qn * (a + Cs(this.gtu, 2 * a));
      },
      forward: function (t) {
        var s = Ht(t.x - this.long0),
          i = t.y;
        i = As(this.cbg, i);
        var a = Math.sin(i),
          h = Math.cos(i),
          e = Math.sin(s),
          n = Math.cos(s);
        (i = Math.atan2(a, n * h)),
          (s = Math.atan2(e * h, ws(a, h * n))),
          (s = Es(Math.tan(s)));
        var r = Ss(this.gtu, 2 * i, 2 * s);
        (i += r[0]), (s += r[1]);
        var o, l;
        return (
          Math.abs(s) <= 2.623395162778
            ? ((o = this.a * (this.Qn * s) + this.x0),
              (l = this.a * (this.Qn * i + this.Zb) + this.y0))
            : ((o = 1 / 0), (l = 1 / 0)),
          (t.x = o),
          (t.y = l),
          t
        );
      },
      inverse: function (t) {
        var s = (t.x - this.x0) * (1 / this.a),
          i = (t.y - this.y0) * (1 / this.a);
        (i = (i - this.Zb) / this.Qn), (s /= this.Qn);
        var a, h;
        if (Math.abs(s) <= 2.623395162778) {
          var e = Ss(this.utg, 2 * i, 2 * s);
          (i += e[0]), (s += e[1]), (s = Math.atan(bs(s)));
          var n = Math.sin(i),
            r = Math.cos(i),
            o = Math.sin(s),
            l = Math.cos(s);
          (i = Math.atan2(n * l, ws(o, l * r))),
            (s = Math.atan2(o, l * r)),
            (a = Ht(s + this.long0)),
            (h = As(this.cgb, i));
        } else (a = 1 / 0), (h = 1 / 0);
        return (t.x = a), (t.y = h), t;
      },
      names: [
        "Extended_Transverse_Mercator",
        "Extended Transverse Mercator",
        "etmerc",
        "Transverse_Mercator",
        "Transverse Mercator",
        "Gauss Kruger",
        "Gauss_Kruger",
        "tmerc",
      ],
    },
    Os = function (t, s) {
      if (void 0 === t) {
        if ((t = Math.floor((30 * (Ht(s) + Math.PI)) / Math.PI) + 1) < 0)
          return 0;
        if (t > 60) return 60;
      }
      return t;
    },
    ks = {
      init: function () {
        var t = Os(this.zone, this.long0);
        if (void 0 === t) throw new Error("unknown utm zone");
        (this.lat0 = 0),
          (this.long0 = (6 * Math.abs(t) - 183) * Nt),
          (this.x0 = 5e5),
          (this.y0 = this.utmSouth ? 1e7 : 0),
          (this.k0 = 0.9996),
          Is.init.apply(this),
          (this.forward = Is.forward),
          (this.inverse = Is.inverse);
      },
      names: ["Universal Transverse Mercator System", "utm"],
      dependsOn: "etmerc",
    },
    qs = function (t, s) {
      return Math.pow((1 - t) / (1 + t), s);
    },
    Rs = 20,
    Ls = {
      init: function () {
        var t = Math.sin(this.lat0),
          s = Math.cos(this.lat0);
        (s *= s),
          (this.rc = Math.sqrt(1 - this.es) / (1 - this.es * t * t)),
          (this.C = Math.sqrt(1 + (this.es * s * s) / (1 - this.es))),
          (this.phic0 = Math.asin(t / this.C)),
          (this.ratexp = 0.5 * this.C * this.e),
          (this.K =
            Math.tan(0.5 * this.phic0 + At) /
            (Math.pow(Math.tan(0.5 * this.lat0 + At), this.C) *
              qs(this.e * t, this.ratexp)));
      },
      forward: function (t) {
        var s = t.x,
          i = t.y;
        return (
          (t.y =
            2 *
              Math.atan(
                this.K *
                  Math.pow(Math.tan(0.5 * i + At), this.C) *
                  qs(this.e * Math.sin(i), this.ratexp),
              ) -
            xt),
          (t.x = this.C * s),
          t
        );
      },
      inverse: function (t) {
        for (
          var s = t.x / this.C,
            i = t.y,
            a = Math.pow(Math.tan(0.5 * i + At) / this.K, 1 / this.C),
            h = Rs;
          h > 0 &&
          ((i =
            2 * Math.atan(a * qs(this.e * Math.sin(t.y), -0.5 * this.e)) - xt),
          !(Math.abs(i - t.y) < 1e-14));
          --h
        )
          t.y = i;
        return h ? ((t.x = s), (t.y = i), t) : null;
      },
      names: ["gauss"],
    },
    Gs = {
      init: function () {
        Ls.init.apply(this),
          this.rc &&
            ((this.sinc0 = Math.sin(this.phic0)),
            (this.cosc0 = Math.cos(this.phic0)),
            (this.R2 = 2 * this.rc),
            this.title || (this.title = "Oblique Stereographic Alternative"));
      },
      forward: function (t) {
        var s, i, a, h;
        return (
          (t.x = Ht(t.x - this.long0)),
          Ls.forward.apply(this, [t]),
          (s = Math.sin(t.y)),
          (i = Math.cos(t.y)),
          (a = Math.cos(t.x)),
          (h = (this.k0 * this.R2) / (1 + this.sinc0 * s + this.cosc0 * i * a)),
          (t.x = h * i * Math.sin(t.x)),
          (t.y = h * (this.cosc0 * s - this.sinc0 * i * a)),
          (t.x = this.a * t.x + this.x0),
          (t.y = this.a * t.y + this.y0),
          t
        );
      },
      inverse: function (t) {
        var s, i, a, h, e;
        if (
          ((t.x = (t.x - this.x0) / this.a),
          (t.y = (t.y - this.y0) / this.a),
          (t.x /= this.k0),
          (t.y /= this.k0),
          (e = ws(t.x, t.y)))
        ) {
          var n = 2 * Math.atan2(e, this.R2);
          (s = Math.sin(n)),
            (i = Math.cos(n)),
            (h = Math.asin(i * this.sinc0 + (t.y * s * this.cosc0) / e)),
            (a = Math.atan2(
              t.x * s,
              e * this.cosc0 * i - t.y * this.sinc0 * s,
            ));
        } else (h = this.phic0), (a = 0);
        return (
          (t.x = a),
          (t.y = h),
          Ls.inverse.apply(this, [t]),
          (t.x = Ht(t.x + this.long0)),
          t
        );
      },
      names: [
        "Stereographic_North_Pole",
        "Oblique_Stereographic",
        "sterea",
        "Oblique Stereographic Alternative",
        "Double_Stereographic",
      ],
    },
    Ts = {
      init: function () {
        (this.x0 = this.x0 || 0),
          (this.y0 = this.y0 || 0),
          (this.lat0 = this.lat0 || 0),
          (this.long0 = this.long0 || 0),
          (this.coslat0 = Math.cos(this.lat0)),
          (this.sinlat0 = Math.sin(this.lat0)),
          this.sphere
            ? 1 === this.k0 &&
              !isNaN(this.lat_ts) &&
              Math.abs(this.coslat0) <= wt &&
              (this.k0 = 0.5 * (1 + Wt(this.lat0) * Math.sin(this.lat_ts)))
            : (Math.abs(this.coslat0) <= wt &&
                (this.lat0 > 0 ? (this.con = 1) : (this.con = -1)),
              (this.cons = Math.sqrt(
                Math.pow(1 + this.e, 1 + this.e) *
                  Math.pow(1 - this.e, 1 - this.e),
              )),
              1 === this.k0 &&
                !isNaN(this.lat_ts) &&
                Math.abs(this.coslat0) <= wt &&
                Math.abs(Math.cos(this.lat_ts)) > wt &&
                (this.k0 =
                  (0.5 *
                    this.cons *
                    Qt(this.e, Math.sin(this.lat_ts), Math.cos(this.lat_ts))) /
                  Xt(
                    this.e,
                    this.con * this.lat_ts,
                    this.con * Math.sin(this.lat_ts),
                  )),
              (this.ms1 = Qt(this.e, this.sinlat0, this.coslat0)),
              (this.X0 =
                2 * Math.atan(this.ssfn_(this.lat0, this.sinlat0, this.e)) -
                xt),
              (this.cosX0 = Math.cos(this.X0)),
              (this.sinX0 = Math.sin(this.X0)));
      },
      forward: function (t) {
        var s,
          i,
          a,
          h,
          e,
          n,
          r = t.x,
          o = t.y,
          l = Math.sin(o),
          u = Math.cos(o),
          c = Ht(r - this.long0);
        return Math.abs(Math.abs(r - this.long0) - Math.PI) <= wt &&
          Math.abs(o + this.lat0) <= wt
          ? ((t.x = NaN), (t.y = NaN), t)
          : this.sphere
            ? ((s =
                (2 * this.k0) /
                (1 + this.sinlat0 * l + this.coslat0 * u * Math.cos(c))),
              (t.x = this.a * s * u * Math.sin(c) + this.x0),
              (t.y =
                this.a *
                  s *
                  (this.coslat0 * l - this.sinlat0 * u * Math.cos(c)) +
                this.y0),
              t)
            : ((i = 2 * Math.atan(this.ssfn_(o, l, this.e)) - xt),
              (h = Math.cos(i)),
              (a = Math.sin(i)),
              Math.abs(this.coslat0) <= wt
                ? ((e = Xt(this.e, o * this.con, this.con * l)),
                  (n = (2 * this.a * this.k0 * e) / this.cons),
                  (t.x = this.x0 + n * Math.sin(r - this.long0)),
                  (t.y = this.y0 - this.con * n * Math.cos(r - this.long0)),
                  t)
                : (Math.abs(this.sinlat0) < wt
                    ? ((s = (2 * this.a * this.k0) / (1 + h * Math.cos(c))),
                      (t.y = s * a))
                    : ((s =
                        (2 * this.a * this.k0 * this.ms1) /
                        (this.cosX0 *
                          (1 + this.sinX0 * a + this.cosX0 * h * Math.cos(c)))),
                      (t.y =
                        s * (this.cosX0 * a - this.sinX0 * h * Math.cos(c)) +
                        this.y0)),
                  (t.x = s * h * Math.sin(c) + this.x0),
                  t));
      },
      inverse: function (t) {
        (t.x -= this.x0), (t.y -= this.y0);
        var s,
          i,
          a,
          h,
          e,
          n = Math.sqrt(t.x * t.x + t.y * t.y);
        if (this.sphere) {
          var r = 2 * Math.atan(n / (2 * this.a * this.k0));
          return (
            (s = this.long0),
            (i = this.lat0),
            n <= wt
              ? ((t.x = s), (t.y = i), t)
              : ((i = Math.asin(
                  Math.cos(r) * this.sinlat0 +
                    (t.y * Math.sin(r) * this.coslat0) / n,
                )),
                (s = Ht(
                  Math.abs(this.coslat0) < wt
                    ? this.lat0 > 0
                      ? this.long0 + Math.atan2(t.x, -1 * t.y)
                      : this.long0 + Math.atan2(t.x, t.y)
                    : this.long0 +
                        Math.atan2(
                          t.x * Math.sin(r),
                          n * this.coslat0 * Math.cos(r) -
                            t.y * this.sinlat0 * Math.sin(r),
                        ),
                )),
                (t.x = s),
                (t.y = i),
                t)
          );
        }
        if (Math.abs(this.coslat0) <= wt) {
          if (n <= wt)
            return (i = this.lat0), (s = this.long0), (t.x = s), (t.y = i), t;
          (t.x *= this.con),
            (t.y *= this.con),
            (a = (n * this.cons) / (2 * this.a * this.k0)),
            (i = this.con * Kt(this.e, a)),
            (s =
              this.con * Ht(this.con * this.long0 + Math.atan2(t.x, -1 * t.y)));
        } else
          (h =
            2 *
            Math.atan((n * this.cosX0) / (2 * this.a * this.k0 * this.ms1))),
            (s = this.long0),
            n <= wt
              ? (e = this.X0)
              : ((e = Math.asin(
                  Math.cos(h) * this.sinX0 +
                    (t.y * Math.sin(h) * this.cosX0) / n,
                )),
                (s = Ht(
                  this.long0 +
                    Math.atan2(
                      t.x * Math.sin(h),
                      n * this.cosX0 * Math.cos(h) -
                        t.y * this.sinX0 * Math.sin(h),
                    ),
                ))),
            (i = -1 * Kt(this.e, Math.tan(0.5 * (xt + e))));
        return (t.x = s), (t.y = i), t;
      },
      names: [
        "stere",
        "Stereographic_South_Pole",
        "Polar Stereographic (variant B)",
        "Polar_Stereographic",
      ],
      ssfn_: function (t, s, i) {
        return (
          (s *= i),
          Math.tan(0.5 * (xt + t)) * Math.pow((1 - s) / (1 + s), 0.5 * i)
        );
      },
    },
    js = {
      init: function () {
        var t = this.lat0;
        this.lambda0 = this.long0;
        var s = Math.sin(t),
          i = this.a,
          a = 1 / this.rf,
          h = 2 * a - Math.pow(a, 2),
          e = (this.e = Math.sqrt(h));
        (this.R = (this.k0 * i * Math.sqrt(1 - h)) / (1 - h * Math.pow(s, 2))),
          (this.alpha = Math.sqrt(
            1 + (h / (1 - h)) * Math.pow(Math.cos(t), 4),
          )),
          (this.b0 = Math.asin(s / this.alpha));
        var n = Math.log(Math.tan(Math.PI / 4 + this.b0 / 2)),
          r = Math.log(Math.tan(Math.PI / 4 + t / 2)),
          o = Math.log((1 + e * s) / (1 - e * s));
        this.K = n - this.alpha * r + ((this.alpha * e) / 2) * o;
      },
      forward: function (t) {
        var s = Math.log(Math.tan(Math.PI / 4 - t.y / 2)),
          i =
            (this.e / 2) *
            Math.log(
              (1 + this.e * Math.sin(t.y)) / (1 - this.e * Math.sin(t.y)),
            ),
          a = -this.alpha * (s + i) + this.K,
          h = 2 * (Math.atan(Math.exp(a)) - Math.PI / 4),
          e = this.alpha * (t.x - this.lambda0),
          n = Math.atan(
            Math.sin(e) /
              (Math.sin(this.b0) * Math.tan(h) +
                Math.cos(this.b0) * Math.cos(e)),
          ),
          r = Math.asin(
            Math.cos(this.b0) * Math.sin(h) -
              Math.sin(this.b0) * Math.cos(h) * Math.cos(e),
          );
        return (
          (t.y =
            (this.R / 2) * Math.log((1 + Math.sin(r)) / (1 - Math.sin(r))) +
            this.y0),
          (t.x = this.R * n + this.x0),
          t
        );
      },
      inverse: function (t) {
        for (
          var s = t.x - this.x0,
            i = t.y - this.y0,
            a = s / this.R,
            h = 2 * (Math.atan(Math.exp(i / this.R)) - Math.PI / 4),
            e = Math.asin(
              Math.cos(this.b0) * Math.sin(h) +
                Math.sin(this.b0) * Math.cos(h) * Math.cos(a),
            ),
            n = Math.atan(
              Math.sin(a) /
                (Math.cos(this.b0) * Math.cos(a) -
                  Math.sin(this.b0) * Math.tan(h)),
            ),
            r = this.lambda0 + n / this.alpha,
            o = 0,
            l = e,
            u = -1e3,
            c = 0;
          Math.abs(l - u) > 1e-7;

        ) {
          if (++c > 20) return;
          (o =
            (1 / this.alpha) *
              (Math.log(Math.tan(Math.PI / 4 + e / 2)) - this.K) +
            this.e *
              Math.log(
                Math.tan(Math.PI / 4 + Math.asin(this.e * Math.sin(l)) / 2),
              )),
            (u = l),
            (l = 2 * Math.atan(Math.exp(o)) - Math.PI / 2);
        }
        return (t.x = r), (t.y = l), t;
      },
      names: ["somerc"],
    },
    Bs = 1e-7,
    zs = {
      init: function () {
        var t,
          s,
          i,
          a,
          h,
          e,
          n,
          r,
          o,
          l,
          u,
          c = 0,
          M = 0,
          f = 0,
          d = 0,
          p = 0,
          m = 0,
          y = 0;
        (this.no_off = rt(this)), (this.no_rot = "no_rot" in this);
        var _ = !1;
        "alpha" in this && (_ = !0);
        var x = !1;
        if (
          ("rectified_grid_angle" in this && (x = !0),
          _ && (y = this.alpha),
          x && (c = this.rectified_grid_angle * Nt),
          _ || x)
        )
          M = this.longc;
        else if (
          ((f = this.long1),
          (p = this.lat1),
          (d = this.long2),
          (m = this.lat2),
          Math.abs(p - m) <= Bs ||
            (t = Math.abs(p)) <= Bs ||
            Math.abs(t - xt) <= Bs ||
            Math.abs(Math.abs(this.lat0) - xt) <= Bs ||
            Math.abs(Math.abs(m) - xt) <= Bs)
        )
          throw new Error();
        var g = 1 - this.es;
        (s = Math.sqrt(g)),
          Math.abs(this.lat0) > wt
            ? ((r = Math.sin(this.lat0)),
              (i = Math.cos(this.lat0)),
              (t = 1 - this.es * r * r),
              (this.B = i * i),
              (this.B = Math.sqrt(1 + (this.es * this.B * this.B) / g)),
              (this.A = (this.B * this.k0 * s) / t),
              (h = (a = (this.B * s) / (i * Math.sqrt(t))) * a - 1) <= 0
                ? (h = 0)
                : ((h = Math.sqrt(h)), this.lat0 < 0 && (h = -h)),
              (this.E = h += a),
              (this.E *= Math.pow(Xt(this.e, this.lat0, r), this.B)))
            : ((this.B = 1 / s), (this.A = this.k0), (this.E = a = h = 1)),
          _ || x
            ? (_
                ? ((u = Math.asin(Math.sin(y) / a)), x || (c = y))
                : ((u = c), (y = Math.asin(a * Math.sin(u)))),
              (this.lam0 =
                M - Math.asin(0.5 * (h - 1 / h) * Math.tan(u)) / this.B))
            : ((e = Math.pow(Xt(this.e, p, Math.sin(p)), this.B)),
              (n = Math.pow(Xt(this.e, m, Math.sin(m)), this.B)),
              (h = this.E / e),
              (o = (n - e) / (n + e)),
              (l = ((l = this.E * this.E) - n * e) / (l + n * e)),
              (t = f - d) < -Math.pi ? (d -= Ct) : t > Math.pi && (d += Ct),
              (this.lam0 = Ht(
                0.5 * (f + d) -
                  Math.atan((l * Math.tan(0.5 * this.B * (f - d))) / o) /
                    this.B,
              )),
              (u = Math.atan(
                (2 * Math.sin(this.B * Ht(f - this.lam0))) / (h - 1 / h),
              )),
              (c = y = Math.asin(a * Math.sin(u)))),
          (this.singam = Math.sin(u)),
          (this.cosgam = Math.cos(u)),
          (this.sinrot = Math.sin(c)),
          (this.cosrot = Math.cos(c)),
          (this.rB = 1 / this.B),
          (this.ArB = this.A * this.rB),
          (this.BrA = 1 / this.ArB),
          this.no_off
            ? (this.u_0 = 0)
            : ((this.u_0 = Math.abs(
                this.ArB * Math.atan(Math.sqrt(a * a - 1) / Math.cos(y)),
              )),
              this.lat0 < 0 && (this.u_0 = -this.u_0)),
          (h = 0.5 * u),
          (this.v_pole_n = this.ArB * Math.log(Math.tan(At - h))),
          (this.v_pole_s = this.ArB * Math.log(Math.tan(At + h)));
      },
      forward: function (t) {
        var s,
          i,
          a,
          h,
          e,
          n,
          r,
          o,
          l = {};
        if (((t.x = t.x - this.lam0), Math.abs(Math.abs(t.y) - xt) > wt)) {
          if (
            ((e = this.E / Math.pow(Xt(this.e, t.y, Math.sin(t.y)), this.B)),
            (n = 1 / e),
            (s = 0.5 * (e - n)),
            (i = 0.5 * (e + n)),
            (h = Math.sin(this.B * t.x)),
            (a = (s * this.singam - h * this.cosgam) / i),
            Math.abs(Math.abs(a) - 1) < wt)
          )
            throw new Error();
          (o = 0.5 * this.ArB * Math.log((1 - a) / (1 + a))),
            (n = Math.cos(this.B * t.x)),
            (r =
              Math.abs(n) < Bs
                ? this.A * t.x
                : this.ArB * Math.atan2(s * this.cosgam + h * this.singam, n));
        } else
          (o = t.y > 0 ? this.v_pole_n : this.v_pole_s), (r = this.ArB * t.y);
        return (
          this.no_rot
            ? ((l.x = r), (l.y = o))
            : ((r -= this.u_0),
              (l.x = o * this.cosrot + r * this.sinrot),
              (l.y = r * this.cosrot - o * this.sinrot)),
          (l.x = this.a * l.x + this.x0),
          (l.y = this.a * l.y + this.y0),
          l
        );
      },
      inverse: function (t) {
        var s,
          i,
          a,
          h,
          e,
          n,
          r,
          o = {};
        if (
          ((t.x = (t.x - this.x0) * (1 / this.a)),
          (t.y = (t.y - this.y0) * (1 / this.a)),
          this.no_rot
            ? ((i = t.y), (s = t.x))
            : ((i = t.x * this.cosrot - t.y * this.sinrot),
              (s = t.y * this.cosrot + t.x * this.sinrot + this.u_0)),
          (a = Math.exp(-this.BrA * i)),
          (h = 0.5 * (a - 1 / a)),
          (e = 0.5 * (a + 1 / a)),
          (n = Math.sin(this.BrA * s)),
          (r = (n * this.cosgam + h * this.singam) / e),
          Math.abs(Math.abs(r) - 1) < wt)
        )
          (o.x = 0), (o.y = r < 0 ? -xt : xt);
        else {
          if (
            ((o.y = this.E / Math.sqrt((1 + r) / (1 - r))),
            (o.y = Kt(this.e, Math.pow(o.y, 1 / this.B))),
            o.y === 1 / 0)
          )
            throw new Error();
          o.x =
            -this.rB *
            Math.atan2(
              h * this.cosgam - n * this.singam,
              Math.cos(this.BrA * s),
            );
        }
        return (o.x += this.lam0), o;
      },
      names: [
        "Hotine_Oblique_Mercator",
        "Hotine Oblique Mercator",
        "Hotine_Oblique_Mercator_Azimuth_Natural_Origin",
        "Hotine_Oblique_Mercator_Two_Point_Natural_Origin",
        "Hotine_Oblique_Mercator_Azimuth_Center",
        "Oblique_Mercator",
        "omerc",
      ],
    },
    Fs = {
      init: function () {
        if (
          (this.lat2 || (this.lat2 = this.lat1),
          this.k0 || (this.k0 = 1),
          (this.x0 = this.x0 || 0),
          (this.y0 = this.y0 || 0),
          !(Math.abs(this.lat1 + this.lat2) < wt))
        ) {
          var t = this.b / this.a;
          this.e = Math.sqrt(1 - t * t);
          var s = Math.sin(this.lat1),
            i = Math.cos(this.lat1),
            a = Qt(this.e, s, i),
            h = Xt(this.e, this.lat1, s),
            e = Math.sin(this.lat2),
            n = Math.cos(this.lat2),
            r = Qt(this.e, e, n),
            o = Xt(this.e, this.lat2, e),
            l = Xt(this.e, this.lat0, Math.sin(this.lat0));
          Math.abs(this.lat1 - this.lat2) > wt
            ? (this.ns = Math.log(a / r) / Math.log(h / o))
            : (this.ns = s),
            isNaN(this.ns) && (this.ns = s),
            (this.f0 = a / (this.ns * Math.pow(h, this.ns))),
            (this.rh = this.a * this.f0 * Math.pow(l, this.ns)),
            this.title || (this.title = "Lambert Conformal Conic");
        }
      },
      forward: function (t) {
        var s = t.x,
          i = t.y;
        Math.abs(2 * Math.abs(i) - Math.PI) <= wt &&
          (i = Wt(i) * (xt - 2 * wt));
        var a,
          h,
          e = Math.abs(Math.abs(i) - xt);
        if (e > wt)
          (a = Xt(this.e, i, Math.sin(i))),
            (h = this.a * this.f0 * Math.pow(a, this.ns));
        else {
          if ((e = i * this.ns) <= 0) return null;
          h = 0;
        }
        var n = this.ns * Ht(s - this.long0);
        return (
          (t.x = this.k0 * (h * Math.sin(n)) + this.x0),
          (t.y = this.k0 * (this.rh - h * Math.cos(n)) + this.y0),
          t
        );
      },
      inverse: function (t) {
        var s,
          i,
          a,
          h,
          e,
          n = (t.x - this.x0) / this.k0,
          r = this.rh - (t.y - this.y0) / this.k0;
        this.ns > 0
          ? ((s = Math.sqrt(n * n + r * r)), (i = 1))
          : ((s = -Math.sqrt(n * n + r * r)), (i = -1));
        var o = 0;
        if (
          (0 !== s && (o = Math.atan2(i * n, i * r)), 0 !== s || this.ns > 0)
        ) {
          if (
            ((i = 1 / this.ns),
            (a = Math.pow(s / (this.a * this.f0), i)),
            -9999 === (h = Kt(this.e, a)))
          )
            return null;
        } else h = -xt;
        return (e = Ht(o / this.ns + this.long0)), (t.x = e), (t.y = h), t;
      },
      names: [
        "Lambert Tangential Conformal Conic Projection",
        "Lambert_Conformal_Conic",
        "Lambert_Conformal_Conic_1SP",
        "Lambert_Conformal_Conic_2SP",
        "lcc",
        "Lambert Conic Conformal (1SP)",
        "Lambert Conic Conformal (2SP)",
      ],
    },
    Ds = {
      init: function () {
        (this.a = 6377397.155),
          (this.es = 0.006674372230614),
          (this.e = Math.sqrt(this.es)),
          this.lat0 || (this.lat0 = 0.863937979737193),
          this.long0 || (this.long0 = 0.4334234309119251),
          this.k0 || (this.k0 = 0.9999),
          (this.s45 = 0.785398163397448),
          (this.s90 = 2 * this.s45),
          (this.fi0 = this.lat0),
          (this.e2 = this.es),
          (this.e = Math.sqrt(this.e2)),
          (this.alfa = Math.sqrt(
            1 + (this.e2 * Math.pow(Math.cos(this.fi0), 4)) / (1 - this.e2),
          )),
          (this.uq = 1.04216856380474),
          (this.u0 = Math.asin(Math.sin(this.fi0) / this.alfa)),
          (this.g = Math.pow(
            (1 + this.e * Math.sin(this.fi0)) /
              (1 - this.e * Math.sin(this.fi0)),
            (this.alfa * this.e) / 2,
          )),
          (this.k =
            (Math.tan(this.u0 / 2 + this.s45) /
              Math.pow(Math.tan(this.fi0 / 2 + this.s45), this.alfa)) *
            this.g),
          (this.k1 = this.k0),
          (this.n0 =
            (this.a * Math.sqrt(1 - this.e2)) /
            (1 - this.e2 * Math.pow(Math.sin(this.fi0), 2))),
          (this.s0 = 1.37008346281555),
          (this.n = Math.sin(this.s0)),
          (this.ro0 = (this.k1 * this.n0) / Math.tan(this.s0)),
          (this.ad = this.s90 - this.uq);
      },
      forward: function (t) {
        var s,
          i,
          a,
          h,
          e,
          n,
          r,
          o = t.x,
          l = t.y,
          u = Ht(o - this.long0);
        return (
          (s = Math.pow(
            (1 + this.e * Math.sin(l)) / (1 - this.e * Math.sin(l)),
            (this.alfa * this.e) / 2,
          )),
          (i =
            2 *
            (Math.atan(
              (this.k * Math.pow(Math.tan(l / 2 + this.s45), this.alfa)) / s,
            ) -
              this.s45)),
          (a = -u * this.alfa),
          (h = Math.asin(
            Math.cos(this.ad) * Math.sin(i) +
              Math.sin(this.ad) * Math.cos(i) * Math.cos(a),
          )),
          (e = Math.asin((Math.cos(i) * Math.sin(a)) / Math.cos(h))),
          (n = this.n * e),
          (r =
            (this.ro0 * Math.pow(Math.tan(this.s0 / 2 + this.s45), this.n)) /
            Math.pow(Math.tan(h / 2 + this.s45), this.n)),
          (t.y = (r * Math.cos(n)) / 1),
          (t.x = (r * Math.sin(n)) / 1),
          this.czech || ((t.y *= -1), (t.x *= -1)),
          t
        );
      },
      inverse: function (t) {
        var s,
          i,
          a,
          h,
          e,
          n,
          r,
          o = t.x;
        (t.x = t.y),
          (t.y = o),
          this.czech || ((t.y *= -1), (t.x *= -1)),
          (e = Math.sqrt(t.x * t.x + t.y * t.y)),
          (h = Math.atan2(t.y, t.x) / Math.sin(this.s0)),
          (a =
            2 *
            (Math.atan(
              Math.pow(this.ro0 / e, 1 / this.n) *
                Math.tan(this.s0 / 2 + this.s45),
            ) -
              this.s45)),
          (s = Math.asin(
            Math.cos(this.ad) * Math.sin(a) -
              Math.sin(this.ad) * Math.cos(a) * Math.cos(h),
          )),
          (i = Math.asin((Math.cos(a) * Math.sin(h)) / Math.cos(s))),
          (t.x = this.long0 - i / this.alfa),
          (n = s),
          (r = 0);
        var l = 0;
        do {
          (t.y =
            2 *
            (Math.atan(
              Math.pow(this.k, -1 / this.alfa) *
                Math.pow(Math.tan(s / 2 + this.s45), 1 / this.alfa) *
                Math.pow(
                  (1 + this.e * Math.sin(n)) / (1 - this.e * Math.sin(n)),
                  this.e / 2,
                ),
            ) -
              this.s45)),
            Math.abs(n - t.y) < 1e-10 && (r = 1),
            (n = t.y),
            (l += 1);
        } while (0 === r && l < 15);
        return l >= 15 ? null : t;
      },
      names: ["Krovak", "krovak"],
    },
    Us = function (t, s, i, a, h) {
      return (
        t * h - s * Math.sin(2 * h) + i * Math.sin(4 * h) - a * Math.sin(6 * h)
      );
    },
    Qs = function (t) {
      return 1 - 0.25 * t * (1 + (t / 16) * (3 + 1.25 * t));
    },
    Ws = function (t) {
      return 0.375 * t * (1 + 0.25 * t * (1 + 0.46875 * t));
    },
    Hs = function (t) {
      return 0.05859375 * t * t * (1 + 0.75 * t);
    },
    Xs = function (t) {
      return t * t * t * (35 / 3072);
    },
    Ks = function (t, s, i) {
      var a = s * i;
      return t / Math.sqrt(1 - a * a);
    },
    Js = function (t) {
      return Math.abs(t) < xt ? t : t - Wt(t) * Math.PI;
    },
    Vs = function (t, s, i, a, h) {
      var e, n;
      e = t / s;
      for (var r = 0; r < 15; r++)
        if (
          ((n =
            (t -
              (s * e -
                i * Math.sin(2 * e) +
                a * Math.sin(4 * e) -
                h * Math.sin(6 * e))) /
            (s -
              2 * i * Math.cos(2 * e) +
              4 * a * Math.cos(4 * e) -
              6 * h * Math.cos(6 * e))),
          (e += n),
          Math.abs(n) <= 1e-10)
        )
          return e;
      return NaN;
    },
    Zs = {
      init: function () {
        this.sphere ||
          ((this.e0 = Qs(this.es)),
          (this.e1 = Ws(this.es)),
          (this.e2 = Hs(this.es)),
          (this.e3 = Xs(this.es)),
          (this.ml0 =
            this.a * Us(this.e0, this.e1, this.e2, this.e3, this.lat0)));
      },
      forward: function (t) {
        var s,
          i,
          a = t.x,
          h = t.y;
        if (((a = Ht(a - this.long0)), this.sphere))
          (s = this.a * Math.asin(Math.cos(h) * Math.sin(a))),
            (i = this.a * (Math.atan2(Math.tan(h), Math.cos(a)) - this.lat0));
        else {
          var e = Math.sin(h),
            n = Math.cos(h),
            r = Ks(this.a, this.e, e),
            o = Math.tan(h) * Math.tan(h),
            l = a * Math.cos(h),
            u = l * l,
            c = (this.es * n * n) / (1 - this.es);
          (s = r * l * (1 - u * o * (1 / 6 - ((8 - o + 8 * c) * u) / 120))),
            (i =
              this.a * Us(this.e0, this.e1, this.e2, this.e3, h) -
              this.ml0 +
              ((r * e) / n) * u * (0.5 + ((5 - o + 6 * c) * u) / 24));
        }
        return (t.x = s + this.x0), (t.y = i + this.y0), t;
      },
      inverse: function (t) {
        (t.x -= this.x0), (t.y -= this.y0);
        var s,
          i,
          a = t.x / this.a,
          h = t.y / this.a;
        if (this.sphere) {
          var e = h + this.lat0;
          (s = Math.asin(Math.sin(e) * Math.cos(a))),
            (i = Math.atan2(Math.tan(a), Math.cos(e)));
        } else {
          var n = this.ml0 / this.a + h,
            r = Vs(n, this.e0, this.e1, this.e2, this.e3);
          if (Math.abs(Math.abs(r) - xt) <= wt)
            return (t.x = this.long0), (t.y = xt), h < 0 && (t.y *= -1), t;
          var o = Ks(this.a, this.e, Math.sin(r)),
            l = ((o * o * o) / this.a / this.a) * (1 - this.es),
            u = Math.pow(Math.tan(r), 2),
            c = (a * this.a) / o,
            M = c * c;
          (s =
            r -
            ((o * Math.tan(r)) / l) *
              c *
              c *
              (0.5 - ((1 + 3 * u) * c * c) / 24)),
            (i =
              (c * (1 - M * (u / 3 + ((1 + 3 * u) * u * M) / 15))) /
              Math.cos(r));
        }
        return (t.x = Ht(i + this.long0)), (t.y = Js(s)), t;
      },
      names: ["Cassini", "Cassini_Soldner", "cass"],
    },
    Ys = function (t, s) {
      var i;
      return t > 1e-7
        ? ((i = t * s),
          (1 - t * t) *
            (s / (1 - i * i) - (0.5 / t) * Math.log((1 - i) / (1 + i))))
        : 2 * s;
    },
    $s = 0.3333333333333333,
    ti = 0.17222222222222222,
    si = 0.10257936507936508,
    ii = 0.06388888888888888,
    ai = 0.0664021164021164,
    hi = 0.016415012942191543,
    ei = {
      init: function () {
        var t = Math.abs(this.lat0);
        if (
          (Math.abs(t - xt) < wt
            ? (this.mode = this.lat0 < 0 ? this.S_POLE : this.N_POLE)
            : Math.abs(t) < wt
              ? (this.mode = this.EQUIT)
              : (this.mode = this.OBLIQ),
          this.es > 0)
        ) {
          var s;
          switch (
            ((this.qp = Ys(this.e, 1)),
            (this.mmf = 0.5 / (1 - this.es)),
            (this.apa = ot(this.es)),
            this.mode)
          ) {
            case this.N_POLE:
            case this.S_POLE:
              this.dd = 1;
              break;
            case this.EQUIT:
              (this.rq = Math.sqrt(0.5 * this.qp)),
                (this.dd = 1 / this.rq),
                (this.xmf = 1),
                (this.ymf = 0.5 * this.qp);
              break;
            case this.OBLIQ:
              (this.rq = Math.sqrt(0.5 * this.qp)),
                (s = Math.sin(this.lat0)),
                (this.sinb1 = Ys(this.e, s) / this.qp),
                (this.cosb1 = Math.sqrt(1 - this.sinb1 * this.sinb1)),
                (this.dd =
                  Math.cos(this.lat0) /
                  (Math.sqrt(1 - this.es * s * s) * this.rq * this.cosb1)),
                (this.ymf = (this.xmf = this.rq) / this.dd),
                (this.xmf *= this.dd);
          }
        } else
          this.mode === this.OBLIQ &&
            ((this.sinph0 = Math.sin(this.lat0)),
            (this.cosph0 = Math.cos(this.lat0)));
      },
      forward: function (t) {
        var s,
          i,
          a,
          h,
          e,
          n,
          r,
          o,
          l,
          u,
          c = t.x,
          M = t.y;
        if (((c = Ht(c - this.long0)), this.sphere)) {
          if (
            ((e = Math.sin(M)),
            (u = Math.cos(M)),
            (a = Math.cos(c)),
            this.mode === this.OBLIQ || this.mode === this.EQUIT)
          ) {
            if (
              (i =
                this.mode === this.EQUIT
                  ? 1 + u * a
                  : 1 + this.sinph0 * e + this.cosph0 * u * a) <= wt
            )
              return null;
            (s = (i = Math.sqrt(2 / i)) * u * Math.sin(c)),
              (i *=
                this.mode === this.EQUIT
                  ? e
                  : this.cosph0 * e - this.sinph0 * u * a);
          } else if (this.mode === this.N_POLE || this.mode === this.S_POLE) {
            if (
              (this.mode === this.N_POLE && (a = -a),
              Math.abs(M + this.lat0) < wt)
            )
              return null;
            (i = At - 0.5 * M),
              (s =
                (i =
                  2 * (this.mode === this.S_POLE ? Math.cos(i) : Math.sin(i))) *
                Math.sin(c)),
              (i *= a);
          }
        } else {
          switch (
            ((r = 0),
            (o = 0),
            (l = 0),
            (a = Math.cos(c)),
            (h = Math.sin(c)),
            (e = Math.sin(M)),
            (n = Ys(this.e, e)),
            (this.mode !== this.OBLIQ && this.mode !== this.EQUIT) ||
              ((r = n / this.qp), (o = Math.sqrt(1 - r * r))),
            this.mode)
          ) {
            case this.OBLIQ:
              l = 1 + this.sinb1 * r + this.cosb1 * o * a;
              break;
            case this.EQUIT:
              l = 1 + o * a;
              break;
            case this.N_POLE:
              (l = xt + M), (n = this.qp - n);
              break;
            case this.S_POLE:
              (l = M - xt), (n = this.qp + n);
          }
          if (Math.abs(l) < wt) return null;
          switch (this.mode) {
            case this.OBLIQ:
            case this.EQUIT:
              (l = Math.sqrt(2 / l)),
                (i =
                  this.mode === this.OBLIQ
                    ? this.ymf * l * (this.cosb1 * r - this.sinb1 * o * a)
                    : (l = Math.sqrt(2 / (1 + o * a))) * r * this.ymf),
                (s = this.xmf * l * o * h);
              break;
            case this.N_POLE:
            case this.S_POLE:
              n >= 0
                ? ((s = (l = Math.sqrt(n)) * h),
                  (i = a * (this.mode === this.S_POLE ? l : -l)))
                : (s = i = 0);
          }
        }
        return (t.x = this.a * s + this.x0), (t.y = this.a * i + this.y0), t;
      },
      inverse: function (t) {
        (t.x -= this.x0), (t.y -= this.y0);
        var s,
          i,
          a,
          h,
          e,
          n,
          r,
          o = t.x / this.a,
          l = t.y / this.a;
        if (this.sphere) {
          var u,
            c = 0,
            M = 0;
          if (((u = Math.sqrt(o * o + l * l)), (i = 0.5 * u) > 1)) return null;
          switch (
            ((i = 2 * Math.asin(i)),
            (this.mode !== this.OBLIQ && this.mode !== this.EQUIT) ||
              ((M = Math.sin(i)), (c = Math.cos(i))),
            this.mode)
          ) {
            case this.EQUIT:
              (i = Math.abs(u) <= wt ? 0 : Math.asin((l * M) / u)),
                (o *= M),
                (l = c * u);
              break;
            case this.OBLIQ:
              (i =
                Math.abs(u) <= wt
                  ? this.lat0
                  : Math.asin(c * this.sinph0 + (l * M * this.cosph0) / u)),
                (o *= M * this.cosph0),
                (l = (c - Math.sin(i) * this.sinph0) * u);
              break;
            case this.N_POLE:
              (l = -l), (i = xt - i);
              break;
            case this.S_POLE:
              i -= xt;
          }
          s =
            0 !== l || (this.mode !== this.EQUIT && this.mode !== this.OBLIQ)
              ? Math.atan2(o, l)
              : 0;
        } else {
          if (((r = 0), this.mode === this.OBLIQ || this.mode === this.EQUIT)) {
            if (
              ((o /= this.dd),
              (l *= this.dd),
              (n = Math.sqrt(o * o + l * l)) < wt)
            )
              return (t.x = this.long0), (t.y = this.lat0), t;
            (h = 2 * Math.asin((0.5 * n) / this.rq)),
              (a = Math.cos(h)),
              (o *= h = Math.sin(h)),
              this.mode === this.OBLIQ
                ? ((r = a * this.sinb1 + (l * h * this.cosb1) / n),
                  (e = this.qp * r),
                  (l = n * this.cosb1 * a - l * this.sinb1 * h))
                : ((r = (l * h) / n), (e = this.qp * r), (l = n * a));
          } else if (this.mode === this.N_POLE || this.mode === this.S_POLE) {
            if ((this.mode === this.N_POLE && (l = -l), !(e = o * o + l * l)))
              return (t.x = this.long0), (t.y = this.lat0), t;
            (r = 1 - e / this.qp), this.mode === this.S_POLE && (r = -r);
          }
          (s = Math.atan2(o, l)), (i = lt(Math.asin(r), this.apa));
        }
        return (t.x = Ht(this.long0 + s)), (t.y = i), t;
      },
      names: [
        "Lambert Azimuthal Equal Area",
        "Lambert_Azimuthal_Equal_Area",
        "laea",
      ],
      S_POLE: 1,
      N_POLE: 2,
      EQUIT: 3,
      OBLIQ: 4,
    },
    ni = function (t) {
      return Math.abs(t) > 1 && (t = t > 1 ? 1 : -1), Math.asin(t);
    },
    ri = {
      init: function () {
        Math.abs(this.lat1 + this.lat2) < wt ||
          ((this.temp = this.b / this.a),
          (this.es = 1 - Math.pow(this.temp, 2)),
          (this.e3 = Math.sqrt(this.es)),
          (this.sin_po = Math.sin(this.lat1)),
          (this.cos_po = Math.cos(this.lat1)),
          (this.t1 = this.sin_po),
          (this.con = this.sin_po),
          (this.ms1 = Qt(this.e3, this.sin_po, this.cos_po)),
          (this.qs1 = Ys(this.e3, this.sin_po)),
          (this.sin_po = Math.sin(this.lat2)),
          (this.cos_po = Math.cos(this.lat2)),
          (this.t2 = this.sin_po),
          (this.ms2 = Qt(this.e3, this.sin_po, this.cos_po)),
          (this.qs2 = Ys(this.e3, this.sin_po)),
          (this.sin_po = Math.sin(this.lat0)),
          (this.cos_po = Math.cos(this.lat0)),
          (this.t3 = this.sin_po),
          (this.qs0 = Ys(this.e3, this.sin_po)),
          Math.abs(this.lat1 - this.lat2) > wt
            ? (this.ns0 =
                (this.ms1 * this.ms1 - this.ms2 * this.ms2) /
                (this.qs2 - this.qs1))
            : (this.ns0 = this.con),
          (this.c = this.ms1 * this.ms1 + this.ns0 * this.qs1),
          (this.rh =
            (this.a * Math.sqrt(this.c - this.ns0 * this.qs0)) / this.ns0));
      },
      forward: function (t) {
        var s = t.x,
          i = t.y;
        (this.sin_phi = Math.sin(i)), (this.cos_phi = Math.cos(i));
        var a = Ys(this.e3, this.sin_phi),
          h = (this.a * Math.sqrt(this.c - this.ns0 * a)) / this.ns0,
          e = this.ns0 * Ht(s - this.long0),
          n = h * Math.sin(e) + this.x0,
          r = this.rh - h * Math.cos(e) + this.y0;
        return (t.x = n), (t.y = r), t;
      },
      inverse: function (t) {
        var s, i, a, h, e, n;
        return (
          (t.x -= this.x0),
          (t.y = this.rh - t.y + this.y0),
          this.ns0 >= 0
            ? ((s = Math.sqrt(t.x * t.x + t.y * t.y)), (a = 1))
            : ((s = -Math.sqrt(t.x * t.x + t.y * t.y)), (a = -1)),
          (h = 0),
          0 !== s && (h = Math.atan2(a * t.x, a * t.y)),
          (a = (s * this.ns0) / this.a),
          this.sphere
            ? (n = Math.asin((this.c - a * a) / (2 * this.ns0)))
            : ((i = (this.c - a * a) / this.ns0), (n = this.phi1z(this.e3, i))),
          (e = Ht(h / this.ns0 + this.long0)),
          (t.x = e),
          (t.y = n),
          t
        );
      },
      names: ["Albers_Conic_Equal_Area", "Albers", "aea"],
      phi1z: function (t, s) {
        var i,
          a,
          h,
          e,
          n,
          r = ni(0.5 * s);
        if (t < wt) return r;
        for (var o = t * t, l = 1; l <= 25; l++)
          if (
            ((i = Math.sin(r)),
            (a = Math.cos(r)),
            (h = t * i),
            (e = 1 - h * h),
            (n =
              ((0.5 * e * e) / a) *
              (s / (1 - o) - i / e + (0.5 / t) * Math.log((1 - h) / (1 + h)))),
            (r += n),
            Math.abs(n) <= 1e-7)
          )
            return r;
        return null;
      },
    },
    oi = {
      init: function () {
        (this.sin_p14 = Math.sin(this.lat0)),
          (this.cos_p14 = Math.cos(this.lat0)),
          (this.infinity_dist = 1e3 * this.a),
          (this.rc = 1);
      },
      forward: function (t) {
        var s,
          i,
          a,
          h,
          e,
          n,
          r,
          o = t.x,
          l = t.y;
        return (
          (a = Ht(o - this.long0)),
          (s = Math.sin(l)),
          (i = Math.cos(l)),
          (h = Math.cos(a)),
          (e = this.sin_p14 * s + this.cos_p14 * i * h) > 0 || Math.abs(e) <= wt
            ? ((n = this.x0 + (1 * this.a * i * Math.sin(a)) / e),
              (r =
                this.y0 +
                (1 * this.a * (this.cos_p14 * s - this.sin_p14 * i * h)) / e))
            : ((n = this.x0 + this.infinity_dist * i * Math.sin(a)),
              (r =
                this.y0 +
                this.infinity_dist *
                  (this.cos_p14 * s - this.sin_p14 * i * h))),
          (t.x = n),
          (t.y = r),
          t
        );
      },
      inverse: function (t) {
        var s, i, a, h, e, n;
        return (
          (t.x = (t.x - this.x0) / this.a),
          (t.y = (t.y - this.y0) / this.a),
          (t.x /= this.k0),
          (t.y /= this.k0),
          (s = Math.sqrt(t.x * t.x + t.y * t.y))
            ? ((h = Math.atan2(s, this.rc)),
              (i = Math.sin(h)),
              (a = Math.cos(h)),
              (n = ni(a * this.sin_p14 + (t.y * i * this.cos_p14) / s)),
              (e = Math.atan2(
                t.x * i,
                s * this.cos_p14 * a - t.y * this.sin_p14 * i,
              )),
              (e = Ht(this.long0 + e)))
            : ((n = this.phic0), (e = 0)),
          (t.x = e),
          (t.y = n),
          t
        );
      },
      names: ["gnom"],
    },
    li = function (t, s) {
      var i = 1 - ((1 - t * t) / (2 * t)) * Math.log((1 - t) / (1 + t));
      if (Math.abs(Math.abs(s) - i) < 1e-6) return s < 0 ? -1 * xt : xt;
      for (var a, h, e, n, r = Math.asin(0.5 * s), o = 0; o < 30; o++)
        if (
          ((h = Math.sin(r)),
          (e = Math.cos(r)),
          (n = t * h),
          (a =
            (Math.pow(1 - n * n, 2) / (2 * e)) *
            (s / (1 - t * t) -
              h / (1 - n * n) +
              (0.5 / t) * Math.log((1 - n) / (1 + n)))),
          (r += a),
          Math.abs(a) <= 1e-10)
        )
          return r;
      return NaN;
    },
    ui = {
      init: function () {
        this.sphere ||
          (this.k0 = Qt(this.e, Math.sin(this.lat_ts), Math.cos(this.lat_ts)));
      },
      forward: function (t) {
        var s,
          i,
          a = t.x,
          h = t.y,
          e = Ht(a - this.long0);
        if (this.sphere)
          (s = this.x0 + this.a * e * Math.cos(this.lat_ts)),
            (i = this.y0 + (this.a * Math.sin(h)) / Math.cos(this.lat_ts));
        else {
          var n = Ys(this.e, Math.sin(h));
          (s = this.x0 + this.a * this.k0 * e),
            (i = this.y0 + (this.a * n * 0.5) / this.k0);
        }
        return (t.x = s), (t.y = i), t;
      },
      inverse: function (t) {
        (t.x -= this.x0), (t.y -= this.y0);
        var s, i;
        return (
          this.sphere
            ? ((s = Ht(this.long0 + t.x / this.a / Math.cos(this.lat_ts))),
              (i = Math.asin((t.y / this.a) * Math.cos(this.lat_ts))))
            : ((i = li(this.e, (2 * t.y * this.k0) / this.a)),
              (s = Ht(this.long0 + t.x / (this.a * this.k0)))),
          (t.x = s),
          (t.y = i),
          t
        );
      },
      names: ["cea"],
    },
    ci = {
      init: function () {
        (this.x0 = this.x0 || 0),
          (this.y0 = this.y0 || 0),
          (this.lat0 = this.lat0 || 0),
          (this.long0 = this.long0 || 0),
          (this.lat_ts = this.lat_ts || 0),
          (this.title = this.title || "Equidistant Cylindrical (Plate Carre)"),
          (this.rc = Math.cos(this.lat_ts));
      },
      forward: function (t) {
        var s = t.x,
          i = t.y,
          a = Ht(s - this.long0),
          h = Js(i - this.lat0);
        return (
          (t.x = this.x0 + this.a * a * this.rc),
          (t.y = this.y0 + this.a * h),
          t
        );
      },
      inverse: function (t) {
        var s = t.x,
          i = t.y;
        return (
          (t.x = Ht(this.long0 + (s - this.x0) / (this.a * this.rc))),
          (t.y = Js(this.lat0 + (i - this.y0) / this.a)),
          t
        );
      },
      names: ["Equirectangular", "Equidistant_Cylindrical", "eqc"],
    },
    Mi = 20,
    fi = {
      init: function () {
        (this.temp = this.b / this.a),
          (this.es = 1 - Math.pow(this.temp, 2)),
          (this.e = Math.sqrt(this.es)),
          (this.e0 = Qs(this.es)),
          (this.e1 = Ws(this.es)),
          (this.e2 = Hs(this.es)),
          (this.e3 = Xs(this.es)),
          (this.ml0 =
            this.a * Us(this.e0, this.e1, this.e2, this.e3, this.lat0));
      },
      forward: function (t) {
        var s,
          i,
          a,
          h = t.x,
          e = t.y,
          n = Ht(h - this.long0);
        if (((a = n * Math.sin(e)), this.sphere))
          Math.abs(e) <= wt
            ? ((s = this.a * n), (i = -1 * this.a * this.lat0))
            : ((s = (this.a * Math.sin(a)) / Math.tan(e)),
              (i =
                this.a *
                (Js(e - this.lat0) + (1 - Math.cos(a)) / Math.tan(e))));
        else if (Math.abs(e) <= wt) (s = this.a * n), (i = -1 * this.ml0);
        else {
          var r = Ks(this.a, this.e, Math.sin(e)) / Math.tan(e);
          (s = r * Math.sin(a)),
            (i =
              this.a * Us(this.e0, this.e1, this.e2, this.e3, e) -
              this.ml0 +
              r * (1 - Math.cos(a)));
        }
        return (t.x = s + this.x0), (t.y = i + this.y0), t;
      },
      inverse: function (t) {
        var s, i, a, h, e, n, r, o, l;
        if (((a = t.x - this.x0), (h = t.y - this.y0), this.sphere))
          if (Math.abs(h + this.a * this.lat0) <= wt)
            (s = Ht(a / this.a + this.long0)), (i = 0);
          else {
            (n = this.lat0 + h / this.a),
              (r = (a * a) / this.a / this.a + n * n),
              (o = n);
            var u;
            for (e = Mi; e; --e)
              if (
                ((u = Math.tan(o)),
                (l =
                  (-1 * (n * (o * u + 1) - o - 0.5 * (o * o + r) * u)) /
                  ((o - n) / u - 1)),
                (o += l),
                Math.abs(l) <= wt)
              ) {
                i = o;
                break;
              }
            s = Ht(
              this.long0 + Math.asin((a * Math.tan(o)) / this.a) / Math.sin(i),
            );
          }
        else if (Math.abs(h + this.ml0) <= wt)
          (i = 0), (s = Ht(this.long0 + a / this.a));
        else {
          (n = (this.ml0 + h) / this.a),
            (r = (a * a) / this.a / this.a + n * n),
            (o = n);
          var c, M, f, d, p;
          for (e = Mi; e; --e)
            if (
              ((p = this.e * Math.sin(o)),
              (c = Math.sqrt(1 - p * p) * Math.tan(o)),
              (M = this.a * Us(this.e0, this.e1, this.e2, this.e3, o)),
              (f =
                this.e0 -
                2 * this.e1 * Math.cos(2 * o) +
                4 * this.e2 * Math.cos(4 * o) -
                6 * this.e3 * Math.cos(6 * o)),
              (d = M / this.a),
              (l =
                (n * (c * d + 1) - d - 0.5 * c * (d * d + r)) /
                ((this.es * Math.sin(2 * o) * (d * d + r - 2 * n * d)) /
                  (4 * c) +
                  (n - d) * (c * f - 2 / Math.sin(2 * o)) -
                  f)),
              (o -= l),
              Math.abs(l) <= wt)
            ) {
              i = o;
              break;
            }
          (c = Math.sqrt(1 - this.es * Math.pow(Math.sin(i), 2)) * Math.tan(i)),
            (s = Ht(this.long0 + Math.asin((a * c) / this.a) / Math.sin(i)));
        }
        return (t.x = s), (t.y = i), t;
      },
      names: ["Polyconic", "poly"],
    },
    di = {
      init: function () {
        (this.A = []),
          (this.A[1] = 0.6399175073),
          (this.A[2] = -0.1358797613),
          (this.A[3] = 0.063294409),
          (this.A[4] = -0.02526853),
          (this.A[5] = 0.0117879),
          (this.A[6] = -0.0055161),
          (this.A[7] = 0.0026906),
          (this.A[8] = -0.001333),
          (this.A[9] = 67e-5),
          (this.A[10] = -34e-5),
          (this.B_re = []),
          (this.B_im = []),
          (this.B_re[1] = 0.7557853228),
          (this.B_im[1] = 0),
          (this.B_re[2] = 0.249204646),
          (this.B_im[2] = 0.003371507),
          (this.B_re[3] = -0.001541739),
          (this.B_im[3] = 0.04105856),
          (this.B_re[4] = -0.10162907),
          (this.B_im[4] = 0.01727609),
          (this.B_re[5] = -0.26623489),
          (this.B_im[5] = -0.36249218),
          (this.B_re[6] = -0.6870983),
          (this.B_im[6] = -1.1651967),
          (this.C_re = []),
          (this.C_im = []),
          (this.C_re[1] = 1.3231270439),
          (this.C_im[1] = 0),
          (this.C_re[2] = -0.577245789),
          (this.C_im[2] = -0.007809598),
          (this.C_re[3] = 0.508307513),
          (this.C_im[3] = -0.112208952),
          (this.C_re[4] = -0.15094762),
          (this.C_im[4] = 0.18200602),
          (this.C_re[5] = 1.01418179),
          (this.C_im[5] = 1.64497696),
          (this.C_re[6] = 1.9660549),
          (this.C_im[6] = 2.5127645),
          (this.D = []),
          (this.D[1] = 1.5627014243),
          (this.D[2] = 0.5185406398),
          (this.D[3] = -0.03333098),
          (this.D[4] = -0.1052906),
          (this.D[5] = -0.0368594),
          (this.D[6] = 0.007317),
          (this.D[7] = 0.0122),
          (this.D[8] = 0.00394),
          (this.D[9] = -0.0013);
      },
      forward: function (t) {
        var s,
          i = t.x,
          a = t.y - this.lat0,
          h = i - this.long0,
          e = (a / _t) * 1e-5,
          n = h,
          r = 1,
          o = 0;
        for (s = 1; s <= 10; s++) (r *= e), (o += this.A[s] * r);
        var l,
          u = o,
          c = n,
          M = 1,
          f = 0,
          d = 0,
          p = 0;
        for (s = 1; s <= 6; s++)
          (l = f * u + M * c),
            (M = M * u - f * c),
            (f = l),
            (d = d + this.B_re[s] * M - this.B_im[s] * f),
            (p = p + this.B_im[s] * M + this.B_re[s] * f);
        return (t.x = p * this.a + this.x0), (t.y = d * this.a + this.y0), t;
      },
      inverse: function (t) {
        var s,
          i,
          a = t.x,
          h = t.y,
          e = a - this.x0,
          n = (h - this.y0) / this.a,
          r = e / this.a,
          o = 1,
          l = 0,
          u = 0,
          c = 0;
        for (s = 1; s <= 6; s++)
          (i = l * n + o * r),
            (o = o * n - l * r),
            (l = i),
            (u = u + this.C_re[s] * o - this.C_im[s] * l),
            (c = c + this.C_im[s] * o + this.C_re[s] * l);
        for (var M = 0; M < this.iterations; M++) {
          var f,
            d = u,
            p = c,
            m = n,
            y = r;
          for (s = 2; s <= 6; s++)
            (f = p * u + d * c),
              (d = d * u - p * c),
              (p = f),
              (m += (s - 1) * (this.B_re[s] * d - this.B_im[s] * p)),
              (y += (s - 1) * (this.B_im[s] * d + this.B_re[s] * p));
          (d = 1), (p = 0);
          var _ = this.B_re[1],
            x = this.B_im[1];
          for (s = 2; s <= 6; s++)
            (f = p * u + d * c),
              (d = d * u - p * c),
              (p = f),
              (_ += s * (this.B_re[s] * d - this.B_im[s] * p)),
              (x += s * (this.B_im[s] * d + this.B_re[s] * p));
          var g = _ * _ + x * x;
          (u = (m * _ + y * x) / g), (c = (y * _ - m * x) / g);
        }
        var v = u,
          b = c,
          w = 1,
          N = 0;
        for (s = 1; s <= 9; s++) (w *= v), (N += this.D[s] * w);
        var E = this.lat0 + N * _t * 1e5,
          A = this.long0 + b;
        return (t.x = A), (t.y = E), t;
      },
      names: ["New_Zealand_Map_Grid", "nzmg"],
    },
    pi = {
      init: function () {},
      forward: function (t) {
        var s = t.x,
          i = t.y,
          a = Ht(s - this.long0),
          h = this.x0 + this.a * a,
          e =
            this.y0 + this.a * Math.log(Math.tan(Math.PI / 4 + i / 2.5)) * 1.25;
        return (t.x = h), (t.y = e), t;
      },
      inverse: function (t) {
        (t.x -= this.x0), (t.y -= this.y0);
        var s = Ht(this.long0 + t.x / this.a),
          i = 2.5 * (Math.atan(Math.exp((0.8 * t.y) / this.a)) - Math.PI / 4);
        return (t.x = s), (t.y = i), t;
      },
      names: ["Miller_Cylindrical", "mill"],
    },
    mi = 20,
    yi = {
      init: function () {
        this.sphere
          ? ((this.n = 1),
            (this.m = 0),
            (this.es = 0),
            (this.C_y = Math.sqrt((this.m + 1) / this.n)),
            (this.C_x = this.C_y / (this.m + 1)))
          : (this.en = _s(this.es));
      },
      forward: function (t) {
        var s,
          i,
          a = t.x,
          h = t.y;
        if (((a = Ht(a - this.long0)), this.sphere)) {
          if (this.m)
            for (var e = this.n * Math.sin(h), n = mi; n; --n) {
              var r = (this.m * h + Math.sin(h) - e) / (this.m + Math.cos(h));
              if (((h -= r), Math.abs(r) < wt)) break;
            }
          else h = 1 !== this.n ? Math.asin(this.n * Math.sin(h)) : h;
          (s = this.a * this.C_x * a * (this.m + Math.cos(h))),
            (i = this.a * this.C_y * h);
        } else {
          var o = Math.sin(h),
            l = Math.cos(h);
          (i = this.a * xs(h, o, l, this.en)),
            (s = (this.a * a * l) / Math.sqrt(1 - this.es * o * o));
        }
        return (t.x = s), (t.y = i), t;
      },
      inverse: function (t) {
        var s, i, a, h;
        return (
          (t.x -= this.x0),
          (a = t.x / this.a),
          (t.y -= this.y0),
          (s = t.y / this.a),
          this.sphere
            ? ((s /= this.C_y),
              (a /= this.C_x * (this.m + Math.cos(s))),
              this.m
                ? (s = ni((this.m * s + Math.sin(s)) / this.n))
                : 1 !== this.n && (s = ni(Math.sin(s) / this.n)),
              (a = Ht(a + this.long0)),
              (s = Js(s)))
            : ((s = gs(t.y / this.a, this.es, this.en)),
              (h = Math.abs(s)) < xt
                ? ((h = Math.sin(s)),
                  (i =
                    this.long0 +
                    (t.x * Math.sqrt(1 - this.es * h * h)) /
                      (this.a * Math.cos(s))),
                  (a = Ht(i)))
                : h - wt < xt && (a = this.long0)),
          (t.x = a),
          (t.y = s),
          t
        );
      },
      names: ["Sinusoidal", "sinu"],
    },
    _i = {
      init: function () {},
      forward: function (t) {
        for (
          var s = t.x,
            i = t.y,
            a = Ht(s - this.long0),
            h = i,
            e = Math.PI * Math.sin(i);
          ;

        ) {
          var n = -(h + Math.sin(h) - e) / (1 + Math.cos(h));
          if (((h += n), Math.abs(n) < wt)) break;
        }
        (h /= 2), Math.PI / 2 - Math.abs(i) < wt && (a = 0);
        var r = 0.900316316158 * this.a * a * Math.cos(h) + this.x0,
          o = 1.4142135623731 * this.a * Math.sin(h) + this.y0;
        return (t.x = r), (t.y = o), t;
      },
      inverse: function (t) {
        var s, i;
        (t.x -= this.x0),
          (t.y -= this.y0),
          (i = t.y / (1.4142135623731 * this.a)),
          Math.abs(i) > 0.999999999999 && (i = 0.999999999999),
          (s = Math.asin(i));
        var a = Ht(this.long0 + t.x / (0.900316316158 * this.a * Math.cos(s)));
        a < -Math.PI && (a = -Math.PI),
          a > Math.PI && (a = Math.PI),
          (i = (2 * s + Math.sin(2 * s)) / Math.PI),
          Math.abs(i) > 1 && (i = 1);
        var h = Math.asin(i);
        return (t.x = a), (t.y = h), t;
      },
      names: ["Mollweide", "moll"],
    },
    xi = {
      init: function () {
        Math.abs(this.lat1 + this.lat2) < wt ||
          ((this.lat2 = this.lat2 || this.lat1),
          (this.temp = this.b / this.a),
          (this.es = 1 - Math.pow(this.temp, 2)),
          (this.e = Math.sqrt(this.es)),
          (this.e0 = Qs(this.es)),
          (this.e1 = Ws(this.es)),
          (this.e2 = Hs(this.es)),
          (this.e3 = Xs(this.es)),
          (this.sinphi = Math.sin(this.lat1)),
          (this.cosphi = Math.cos(this.lat1)),
          (this.ms1 = Qt(this.e, this.sinphi, this.cosphi)),
          (this.ml1 = Us(this.e0, this.e1, this.e2, this.e3, this.lat1)),
          Math.abs(this.lat1 - this.lat2) < wt
            ? (this.ns = this.sinphi)
            : ((this.sinphi = Math.sin(this.lat2)),
              (this.cosphi = Math.cos(this.lat2)),
              (this.ms2 = Qt(this.e, this.sinphi, this.cosphi)),
              (this.ml2 = Us(this.e0, this.e1, this.e2, this.e3, this.lat2)),
              (this.ns = (this.ms1 - this.ms2) / (this.ml2 - this.ml1))),
          (this.g = this.ml1 + this.ms1 / this.ns),
          (this.ml0 = Us(this.e0, this.e1, this.e2, this.e3, this.lat0)),
          (this.rh = this.a * (this.g - this.ml0)));
      },
      forward: function (t) {
        var s,
          i = t.x,
          a = t.y;
        if (this.sphere) s = this.a * (this.g - a);
        else {
          var h = Us(this.e0, this.e1, this.e2, this.e3, a);
          s = this.a * (this.g - h);
        }
        var e = this.ns * Ht(i - this.long0),
          n = this.x0 + s * Math.sin(e),
          r = this.y0 + this.rh - s * Math.cos(e);
        return (t.x = n), (t.y = r), t;
      },
      inverse: function (t) {
        (t.x -= this.x0), (t.y = this.rh - t.y + this.y0);
        var s, i, a, h;
        this.ns >= 0
          ? ((i = Math.sqrt(t.x * t.x + t.y * t.y)), (s = 1))
          : ((i = -Math.sqrt(t.x * t.x + t.y * t.y)), (s = -1));
        var e = 0;
        if ((0 !== i && (e = Math.atan2(s * t.x, s * t.y)), this.sphere))
          return (
            (h = Ht(this.long0 + e / this.ns)),
            (a = Js(this.g - i / this.a)),
            (t.x = h),
            (t.y = a),
            t
          );
        var n = this.g - i / this.a;
        return (
          (a = Vs(n, this.e0, this.e1, this.e2, this.e3)),
          (h = Ht(this.long0 + e / this.ns)),
          (t.x = h),
          (t.y = a),
          t
        );
      },
      names: ["Equidistant_Conic", "eqdc"],
    },
    gi = {
      init: function () {
        this.R = this.a;
      },
      forward: function (t) {
        var s,
          i,
          a = t.x,
          h = t.y,
          e = Ht(a - this.long0);
        Math.abs(h) <= wt && ((s = this.x0 + this.R * e), (i = this.y0));
        var n = ni(2 * Math.abs(h / Math.PI));
        (Math.abs(e) <= wt || Math.abs(Math.abs(h) - xt) <= wt) &&
          ((s = this.x0),
          (i =
            h >= 0
              ? this.y0 + Math.PI * this.R * Math.tan(0.5 * n)
              : this.y0 + Math.PI * this.R * -Math.tan(0.5 * n)));
        var r = 0.5 * Math.abs(Math.PI / e - e / Math.PI),
          o = r * r,
          l = Math.sin(n),
          u = Math.cos(n),
          c = u / (l + u - 1),
          M = c * c,
          f = c * (2 / l - 1),
          d = f * f,
          p =
            (Math.PI *
              this.R *
              (r * (c - d) +
                Math.sqrt(o * (c - d) * (c - d) - (d + o) * (M - d)))) /
            (d + o);
        e < 0 && (p = -p), (s = this.x0 + p);
        var m = o + c;
        return (
          (p =
            (Math.PI *
              this.R *
              (f * m - r * Math.sqrt((d + o) * (o + 1) - m * m))) /
            (d + o)),
          (i = h >= 0 ? this.y0 + p : this.y0 - p),
          (t.x = s),
          (t.y = i),
          t
        );
      },
      inverse: function (t) {
        var s, i, a, h, e, n, r, o, l, u, c, M, f;
        return (
          (t.x -= this.x0),
          (t.y -= this.y0),
          (c = Math.PI * this.R),
          (a = t.x / c),
          (h = t.y / c),
          (e = a * a + h * h),
          (n = -Math.abs(h) * (1 + e)),
          (r = n - 2 * h * h + a * a),
          (o = -2 * n + 1 + 2 * h * h + e * e),
          (f =
            (h * h) / o +
            ((2 * r * r * r) / o / o / o - (9 * n * r) / o / o) / 27),
          (l = (n - (r * r) / 3 / o) / o),
          (u = 2 * Math.sqrt(-l / 3)),
          (c = (3 * f) / l / u),
          Math.abs(c) > 1 && (c = c >= 0 ? 1 : -1),
          (M = Math.acos(c) / 3),
          (i =
            t.y >= 0
              ? (-u * Math.cos(M + Math.PI / 3) - r / 3 / o) * Math.PI
              : -(-u * Math.cos(M + Math.PI / 3) - r / 3 / o) * Math.PI),
          (s =
            Math.abs(a) < wt
              ? this.long0
              : Ht(
                  this.long0 +
                    (Math.PI *
                      (e - 1 + Math.sqrt(1 + 2 * (a * a - h * h) + e * e))) /
                      2 /
                      a,
                )),
          (t.x = s),
          (t.y = i),
          t
        );
      },
      names: ["Van_der_Grinten_I", "VanDerGrinten", "vandg"],
    },
    vi = {
      init: function () {
        (this.sin_p12 = Math.sin(this.lat0)),
          (this.cos_p12 = Math.cos(this.lat0));
      },
      forward: function (t) {
        var s,
          i,
          a,
          h,
          e,
          n,
          r,
          o,
          l,
          u,
          c,
          M,
          f,
          d,
          p,
          m,
          y,
          _,
          x,
          g,
          v,
          b,
          w,
          N = t.x,
          E = t.y,
          A = Math.sin(t.y),
          C = Math.cos(t.y),
          P = Ht(N - this.long0);
        return this.sphere
          ? Math.abs(this.sin_p12 - 1) <= wt
            ? ((t.x = this.x0 + this.a * (xt - E) * Math.sin(P)),
              (t.y = this.y0 - this.a * (xt - E) * Math.cos(P)),
              t)
            : Math.abs(this.sin_p12 + 1) <= wt
              ? ((t.x = this.x0 + this.a * (xt + E) * Math.sin(P)),
                (t.y = this.y0 + this.a * (xt + E) * Math.cos(P)),
                t)
              : ((_ = this.sin_p12 * A + this.cos_p12 * C * Math.cos(P)),
                (m = Math.acos(_)),
                (y = m ? m / Math.sin(m) : 1),
                (t.x = this.x0 + this.a * y * C * Math.sin(P)),
                (t.y =
                  this.y0 +
                  this.a *
                    y *
                    (this.cos_p12 * A - this.sin_p12 * C * Math.cos(P))),
                t)
          : ((s = Qs(this.es)),
            (i = Ws(this.es)),
            (a = Hs(this.es)),
            (h = Xs(this.es)),
            Math.abs(this.sin_p12 - 1) <= wt
              ? ((e = this.a * Us(s, i, a, h, xt)),
                (n = this.a * Us(s, i, a, h, E)),
                (t.x = this.x0 + (e - n) * Math.sin(P)),
                (t.y = this.y0 - (e - n) * Math.cos(P)),
                t)
              : Math.abs(this.sin_p12 + 1) <= wt
                ? ((e = this.a * Us(s, i, a, h, xt)),
                  (n = this.a * Us(s, i, a, h, E)),
                  (t.x = this.x0 + (e + n) * Math.sin(P)),
                  (t.y = this.y0 + (e + n) * Math.cos(P)),
                  t)
                : ((r = A / C),
                  (o = Ks(this.a, this.e, this.sin_p12)),
                  (l = Ks(this.a, this.e, A)),
                  (u = Math.atan(
                    (1 - this.es) * r + (this.es * o * this.sin_p12) / (l * C),
                  )),
                  (c = Math.atan2(
                    Math.sin(P),
                    this.cos_p12 * Math.tan(u) - this.sin_p12 * Math.cos(P),
                  )),
                  (x =
                    0 === c
                      ? Math.asin(
                          this.cos_p12 * Math.sin(u) -
                            this.sin_p12 * Math.cos(u),
                        )
                      : Math.abs(Math.abs(c) - Math.PI) <= wt
                        ? -Math.asin(
                            this.cos_p12 * Math.sin(u) -
                              this.sin_p12 * Math.cos(u),
                          )
                        : Math.asin((Math.sin(P) * Math.cos(u)) / Math.sin(c))),
                  (M = (this.e * this.sin_p12) / Math.sqrt(1 - this.es)),
                  (f =
                    (this.e * this.cos_p12 * Math.cos(c)) /
                    Math.sqrt(1 - this.es)),
                  (d = M * f),
                  (p = f * f),
                  (g = x * x),
                  (v = g * x),
                  (b = v * x),
                  (w = b * x),
                  (m =
                    o *
                    x *
                    (1 -
                      (g * p * (1 - p)) / 6 +
                      (v / 8) * d * (1 - 2 * p) +
                      (b / 120) * (p * (4 - 7 * p) - 3 * M * M * (1 - 7 * p)) -
                      (w / 48) * d)),
                  (t.x = this.x0 + m * Math.sin(c)),
                  (t.y = this.y0 + m * Math.cos(c)),
                  t));
      },
      inverse: function (t) {
        (t.x -= this.x0), (t.y -= this.y0);
        var s,
          i,
          a,
          h,
          e,
          n,
          r,
          o,
          l,
          u,
          c,
          M,
          f,
          d,
          p,
          m,
          y,
          _,
          x,
          g,
          v,
          b,
          w,
          N;
        if (this.sphere) {
          if ((s = Math.sqrt(t.x * t.x + t.y * t.y)) > 2 * xt * this.a) return;
          return (
            (i = s / this.a),
            (a = Math.sin(i)),
            (h = Math.cos(i)),
            (e = this.long0),
            Math.abs(s) <= wt
              ? (n = this.lat0)
              : ((n = ni(h * this.sin_p12 + (t.y * a * this.cos_p12) / s)),
                (r = Math.abs(this.lat0) - xt),
                (e = Ht(
                  Math.abs(r) <= wt
                    ? this.lat0 >= 0
                      ? this.long0 + Math.atan2(t.x, -t.y)
                      : this.long0 - Math.atan2(-t.x, t.y)
                    : this.long0 +
                        Math.atan2(
                          t.x * a,
                          s * this.cos_p12 * h - t.y * this.sin_p12 * a,
                        ),
                ))),
            (t.x = e),
            (t.y = n),
            t
          );
        }
        return (
          (o = Qs(this.es)),
          (l = Ws(this.es)),
          (u = Hs(this.es)),
          (c = Xs(this.es)),
          Math.abs(this.sin_p12 - 1) <= wt
            ? ((M = this.a * Us(o, l, u, c, xt)),
              (s = Math.sqrt(t.x * t.x + t.y * t.y)),
              (f = M - s),
              (n = Vs(f / this.a, o, l, u, c)),
              (e = Ht(this.long0 + Math.atan2(t.x, -1 * t.y))),
              (t.x = e),
              (t.y = n),
              t)
            : Math.abs(this.sin_p12 + 1) <= wt
              ? ((M = this.a * Us(o, l, u, c, xt)),
                (s = Math.sqrt(t.x * t.x + t.y * t.y)),
                (f = s - M),
                (n = Vs(f / this.a, o, l, u, c)),
                (e = Ht(this.long0 + Math.atan2(t.x, t.y))),
                (t.x = e),
                (t.y = n),
                t)
              : ((s = Math.sqrt(t.x * t.x + t.y * t.y)),
                (m = Math.atan2(t.x, t.y)),
                (d = Ks(this.a, this.e, this.sin_p12)),
                (y = Math.cos(m)),
                (_ = this.e * this.cos_p12 * y),
                (x = (-_ * _) / (1 - this.es)),
                (g =
                  (3 * this.es * (1 - x) * this.sin_p12 * this.cos_p12 * y) /
                  (1 - this.es)),
                (v = s / d),
                (b =
                  v -
                  (x * (1 + x) * Math.pow(v, 3)) / 6 -
                  (g * (1 + 3 * x) * Math.pow(v, 4)) / 24),
                (w = 1 - (x * b * b) / 2 - (v * b * b * b) / 6),
                (p = Math.asin(
                  this.sin_p12 * Math.cos(b) + this.cos_p12 * Math.sin(b) * y,
                )),
                (e = Ht(
                  this.long0 +
                    Math.asin((Math.sin(m) * Math.sin(b)) / Math.cos(p)),
                )),
                (N = Math.sin(p)),
                (n = Math.atan2(
                  (N - this.es * w * this.sin_p12) * Math.tan(p),
                  N * (1 - this.es),
                )),
                (t.x = e),
                (t.y = n),
                t)
        );
      },
      names: ["Azimuthal_Equidistant", "aeqd"],
    },
    bi = {
      init: function () {
        (this.sin_p14 = Math.sin(this.lat0)),
          (this.cos_p14 = Math.cos(this.lat0));
      },
      forward: function (t) {
        var s,
          i,
          a,
          h,
          e,
          n,
          r,
          o = t.x,
          l = t.y;
        return (
          (a = Ht(o - this.long0)),
          (s = Math.sin(l)),
          (i = Math.cos(l)),
          (h = Math.cos(a)),
          ((e = this.sin_p14 * s + this.cos_p14 * i * h) > 0 ||
            Math.abs(e) <= wt) &&
            ((n = 1 * this.a * i * Math.sin(a)),
            (r =
              this.y0 +
              1 * this.a * (this.cos_p14 * s - this.sin_p14 * i * h))),
          (t.x = n),
          (t.y = r),
          t
        );
      },
      inverse: function (t) {
        var s, i, a, h, e, n, r;
        return (
          (t.x -= this.x0),
          (t.y -= this.y0),
          (s = Math.sqrt(t.x * t.x + t.y * t.y)),
          (i = ni(s / this.a)),
          (a = Math.sin(i)),
          (h = Math.cos(i)),
          (n = this.long0),
          Math.abs(s) <= wt
            ? ((r = this.lat0), (t.x = n), (t.y = r), t)
            : ((r = ni(h * this.sin_p14 + (t.y * a * this.cos_p14) / s)),
              (e = Math.abs(this.lat0) - xt),
              Math.abs(e) <= wt
                ? ((n = Ht(
                    this.lat0 >= 0
                      ? this.long0 + Math.atan2(t.x, -t.y)
                      : this.long0 - Math.atan2(-t.x, t.y),
                  )),
                  (t.x = n),
                  (t.y = r),
                  t)
                : ((n = Ht(
                    this.long0 +
                      Math.atan2(
                        t.x * a,
                        s * this.cos_p14 * h - t.y * this.sin_p14 * a,
                      ),
                  )),
                  (t.x = n),
                  (t.y = r),
                  t))
        );
      },
      names: ["ortho"],
    },
    wi = { FRONT: 1, RIGHT: 2, BACK: 3, LEFT: 4, TOP: 5, BOTTOM: 6 },
    Ni = { AREA_0: 1, AREA_1: 2, AREA_2: 3, AREA_3: 4 },
    Ei = {
      init: function () {
        (this.x0 = this.x0 || 0),
          (this.y0 = this.y0 || 0),
          (this.lat0 = this.lat0 || 0),
          (this.long0 = this.long0 || 0),
          (this.lat_ts = this.lat_ts || 0),
          (this.title = this.title || "Quadrilateralized Spherical Cube"),
          this.lat0 >= xt - At / 2
            ? (this.face = wi.TOP)
            : this.lat0 <= -(xt - At / 2)
              ? (this.face = wi.BOTTOM)
              : Math.abs(this.long0) <= At
                ? (this.face = wi.FRONT)
                : Math.abs(this.long0) <= xt + At
                  ? (this.face = this.long0 > 0 ? wi.RIGHT : wi.LEFT)
                  : (this.face = wi.BACK),
          0 !== this.es &&
            ((this.one_minus_f = 1 - (this.a - this.b) / this.a),
            (this.one_minus_f_squared = this.one_minus_f * this.one_minus_f));
      },
      forward: function (t) {
        var s,
          i,
          a,
          h,
          e,
          n,
          r = { x: 0, y: 0 },
          o = { value: 0 };
        if (
          ((t.x -= this.long0),
          (s =
            0 !== this.es
              ? Math.atan(this.one_minus_f_squared * Math.tan(t.y))
              : t.y),
          (i = t.x),
          this.face === wi.TOP)
        )
          (h = xt - s),
            i >= At && i <= xt + At
              ? ((o.value = Ni.AREA_0), (a = i - xt))
              : i > xt + At || i <= -(xt + At)
                ? ((o.value = Ni.AREA_1), (a = i > 0 ? i - Pt : i + Pt))
                : i > -(xt + At) && i <= -At
                  ? ((o.value = Ni.AREA_2), (a = i + xt))
                  : ((o.value = Ni.AREA_3), (a = i));
        else if (this.face === wi.BOTTOM)
          (h = xt + s),
            i >= At && i <= xt + At
              ? ((o.value = Ni.AREA_0), (a = -i + xt))
              : i < At && i >= -At
                ? ((o.value = Ni.AREA_1), (a = -i))
                : i < -At && i >= -(xt + At)
                  ? ((o.value = Ni.AREA_2), (a = -i - xt))
                  : ((o.value = Ni.AREA_3), (a = i > 0 ? -i + Pt : -i - Pt));
        else {
          var l, u, c, M, f, d;
          this.face === wi.RIGHT
            ? (i = ct(i, +xt))
            : this.face === wi.BACK
              ? (i = ct(i, +Pt))
              : this.face === wi.LEFT && (i = ct(i, -xt)),
            (M = Math.sin(s)),
            (f = Math.cos(s)),
            (d = Math.sin(i)),
            (l = f * Math.cos(i)),
            (u = f * d),
            (c = M),
            this.face === wi.FRONT
              ? (a = ut((h = Math.acos(l)), c, u, o))
              : this.face === wi.RIGHT
                ? (a = ut((h = Math.acos(u)), c, -l, o))
                : this.face === wi.BACK
                  ? (a = ut((h = Math.acos(-l)), c, -u, o))
                  : this.face === wi.LEFT
                    ? (a = ut((h = Math.acos(-u)), c, l, o))
                    : ((h = a = 0), (o.value = Ni.AREA_0));
        }
        return (
          (n = Math.atan(
            (12 / Pt) * (a + Math.acos(Math.sin(a) * Math.cos(At)) - xt),
          )),
          (e = Math.sqrt(
            (1 - Math.cos(h)) /
              (Math.cos(n) * Math.cos(n)) /
              (1 - Math.cos(Math.atan(1 / Math.cos(a)))),
          )),
          o.value === Ni.AREA_1
            ? (n += xt)
            : o.value === Ni.AREA_2
              ? (n += Pt)
              : o.value === Ni.AREA_3 && (n += 1.5 * Pt),
          (r.x = e * Math.cos(n)),
          (r.y = e * Math.sin(n)),
          (r.x = r.x * this.a + this.x0),
          (r.y = r.y * this.a + this.y0),
          (t.x = r.x),
          (t.y = r.y),
          t
        );
      },
      inverse: function (t) {
        var s,
          i,
          a,
          h,
          e,
          n,
          r,
          o,
          l,
          u = { lam: 0, phi: 0 },
          c = { value: 0 };
        if (
          ((t.x = (t.x - this.x0) / this.a),
          (t.y = (t.y - this.y0) / this.a),
          (i = Math.atan(Math.sqrt(t.x * t.x + t.y * t.y))),
          (s = Math.atan2(t.y, t.x)),
          t.x >= 0 && t.x >= Math.abs(t.y)
            ? (c.value = Ni.AREA_0)
            : t.y >= 0 && t.y >= Math.abs(t.x)
              ? ((c.value = Ni.AREA_1), (s -= xt))
              : t.x < 0 && -t.x >= Math.abs(t.y)
                ? ((c.value = Ni.AREA_2), (s = s < 0 ? s + Pt : s - Pt))
                : ((c.value = Ni.AREA_3), (s += xt)),
          (l = (Pt / 12) * Math.tan(s)),
          (e = Math.sin(l) / (Math.cos(l) - 1 / Math.sqrt(2))),
          (n = Math.atan(e)),
          (a = Math.cos(s)),
          (h = Math.tan(i)),
          (r = 1 - a * a * h * h * (1 - Math.cos(Math.atan(1 / Math.cos(n))))) <
          -1
            ? (r = -1)
            : r > 1 && (r = 1),
          this.face === wi.TOP)
        )
          (o = Math.acos(r)),
            (u.phi = xt - o),
            c.value === Ni.AREA_0
              ? (u.lam = n + xt)
              : c.value === Ni.AREA_1
                ? (u.lam = n < 0 ? n + Pt : n - Pt)
                : c.value === Ni.AREA_2
                  ? (u.lam = n - xt)
                  : (u.lam = n);
        else if (this.face === wi.BOTTOM)
          (o = Math.acos(r)),
            (u.phi = o - xt),
            c.value === Ni.AREA_0
              ? (u.lam = -n + xt)
              : c.value === Ni.AREA_1
                ? (u.lam = -n)
                : c.value === Ni.AREA_2
                  ? (u.lam = -n - xt)
                  : (u.lam = n < 0 ? -n - Pt : -n + Pt);
        else {
          var M, f, d;
          (l = (M = r) * M),
            (f =
              (l += (d = l >= 1 ? 0 : Math.sqrt(1 - l) * Math.sin(n)) * d) >= 1
                ? 0
                : Math.sqrt(1 - l)),
            c.value === Ni.AREA_1
              ? ((l = f), (f = -d), (d = l))
              : c.value === Ni.AREA_2
                ? ((f = -f), (d = -d))
                : c.value === Ni.AREA_3 && ((l = f), (f = d), (d = -l)),
            this.face === wi.RIGHT
              ? ((l = M), (M = -f), (f = l))
              : this.face === wi.BACK
                ? ((M = -M), (f = -f))
                : this.face === wi.LEFT && ((l = M), (M = f), (f = -l)),
            (u.phi = Math.acos(-d) - xt),
            (u.lam = Math.atan2(f, M)),
            this.face === wi.RIGHT
              ? (u.lam = ct(u.lam, -xt))
              : this.face === wi.BACK
                ? (u.lam = ct(u.lam, -Pt))
                : this.face === wi.LEFT && (u.lam = ct(u.lam, +xt));
        }
        if (0 !== this.es) {
          var p, m, y;
          (p = u.phi < 0 ? 1 : 0),
            (m = Math.tan(u.phi)),
            (y = this.b / Math.sqrt(m * m + this.one_minus_f_squared)),
            (u.phi = Math.atan(
              Math.sqrt(this.a * this.a - y * y) / (this.one_minus_f * y),
            )),
            p && (u.phi = -u.phi);
        }
        return (u.lam += this.long0), (t.x = u.lam), (t.y = u.phi), t;
      },
      names: [
        "Quadrilateralized Spherical Cube",
        "Quadrilateralized_Spherical_Cube",
        "qsc",
      ],
    },
    Ai = [
      [1, 2.2199e-17, -715515e-10, 31103e-10],
      [0.9986, -482243e-9, -24897e-9, -13309e-10],
      [0.9954, -83103e-8, -448605e-10, -9.86701e-7],
      [0.99, -0.00135364, -59661e-9, 36777e-10],
      [0.9822, -0.00167442, -449547e-11, -572411e-11],
      [0.973, -0.00214868, -903571e-10, 1.8736e-8],
      [0.96, -0.00305085, -900761e-10, 164917e-11],
      [0.9427, -0.00382792, -653386e-10, -26154e-10],
      [0.9216, -0.00467746, -10457e-8, 481243e-11],
      [0.8962, -0.00536223, -323831e-10, -543432e-11],
      [0.8679, -0.00609363, -113898e-9, 332484e-11],
      [0.835, -0.00698325, -640253e-10, 9.34959e-7],
      [0.7986, -0.00755338, -500009e-10, 9.35324e-7],
      [0.7597, -0.00798324, -35971e-9, -227626e-11],
      [0.7186, -0.00851367, -701149e-10, -86303e-10],
      [0.6732, -0.00986209, -199569e-9, 191974e-10],
      [0.6213, -0.010418, 883923e-10, 624051e-11],
      [0.5722, -0.00906601, 182e-6, 624051e-11],
      [0.5322, -0.00677797, 275608e-9, 624051e-11],
    ],
    Ci = [
      [-5.20417e-18, 0.0124, 1.21431e-18, -8.45284e-11],
      [0.062, 0.0124, -1.26793e-9, 4.22642e-10],
      [0.124, 0.0124, 5.07171e-9, -1.60604e-9],
      [0.186, 0.0123999, -1.90189e-8, 6.00152e-9],
      [0.248, 0.0124002, 7.10039e-8, -2.24e-8],
      [0.31, 0.0123992, -2.64997e-7, 8.35986e-8],
      [0.372, 0.0124029, 9.88983e-7, -3.11994e-7],
      [0.434, 0.0123893, -369093e-11, -4.35621e-7],
      [0.4958, 0.0123198, -102252e-10, -3.45523e-7],
      [0.5571, 0.0121916, -154081e-10, -5.82288e-7],
      [0.6176, 0.0119938, -241424e-10, -5.25327e-7],
      [0.6769, 0.011713, -320223e-10, -5.16405e-7],
      [0.7346, 0.0113541, -397684e-10, -6.09052e-7],
      [0.7903, 0.0109107, -489042e-10, -104739e-11],
      [0.8435, 0.0103431, -64615e-9, -1.40374e-9],
      [0.8936, 0.00969686, -64636e-9, -8547e-9],
      [0.9394, 0.00840947, -192841e-9, -42106e-10],
      [0.9761, 0.00616527, -256e-6, -42106e-10],
      [1, 0.00328947, -319159e-9, -42106e-10],
    ],
    Pi = 0.8487,
    Si = 1.3523,
    Ii = Et / 5,
    Oi = 1 / Ii,
    ki = 18,
    qi = function (t, s) {
      return t[0] + s * (t[1] + s * (t[2] + s * t[3]));
    },
    Ri = function (t, s) {
      return t[1] + s * (2 * t[2] + 3 * s * t[3]);
    },
    Li = {
      init: function () {
        (this.x0 = this.x0 || 0),
          (this.y0 = this.y0 || 0),
          (this.long0 = this.long0 || 0),
          (this.es = 0),
          (this.title = this.title || "Robinson");
      },
      forward: function (t) {
        var s = Ht(t.x - this.long0),
          i = Math.abs(t.y),
          a = Math.floor(i * Ii);
        a < 0 ? (a = 0) : a >= ki && (a = ki - 1), (i = Et * (i - Oi * a));
        var h = { x: qi(Ai[a], i) * s, y: qi(Ci[a], i) };
        return (
          t.y < 0 && (h.y = -h.y),
          (h.x = h.x * this.a * Pi + this.x0),
          (h.y = h.y * this.a * Si + this.y0),
          h
        );
      },
      inverse: function (t) {
        var s = {
          x: (t.x - this.x0) / (this.a * Pi),
          y: Math.abs(t.y - this.y0) / (this.a * Si),
        };
        if (s.y >= 1) (s.x /= Ai[ki][0]), (s.y = t.y < 0 ? -xt : xt);
        else {
          var i = Math.floor(s.y * ki);
          for (i < 0 ? (i = 0) : i >= ki && (i = ki - 1); ; )
            if (Ci[i][0] > s.y) --i;
            else {
              if (!(Ci[i + 1][0] <= s.y)) break;
              ++i;
            }
          var a = Ci[i],
            h = (5 * (s.y - a[0])) / (Ci[i + 1][0] - a[0]);
          (h = Mt(
            function (t) {
              return (qi(a, t) - s.y) / Ri(a, t);
            },
            h,
            wt,
            100,
          )),
            (s.x /= qi(Ai[i], h)),
            (s.y = (5 * i + h) * Nt),
            t.y < 0 && (s.y = -s.y);
        }
        return (s.x = Ht(s.x + this.long0)), s;
      },
      names: ["Robinson", "robin"],
    },
    Gi = {
      init: function () {
        this.name = "geocent";
      },
      forward: function (t) {
        return k(t, this.es, this.a);
      },
      inverse: function (t) {
        return q(t, this.es, this.a, this.b);
      },
      names: ["Geocentric", "geocentric", "geocent", "Geocent"],
    },
    Ti = { N_POLE: 0, S_POLE: 1, EQUIT: 2, OBLIQ: 3 },
    ji = {
      h: { def: 1e5, num: !0 },
      azi: { def: 0, num: !0, degrees: !0 },
      tilt: { def: 0, num: !0, degrees: !0 },
      long0: { def: 0, num: !0 },
      lat0: { def: 0, num: !0 },
    },
    Bi = {
      init: function () {
        if (
          (Object.keys(ji).forEach(
            function (t) {
              if (void 0 === this[t]) this[t] = ji[t].def;
              else {
                if (ji[t].num && isNaN(this[t]))
                  throw new Error(
                    "Invalid parameter value, must be numeric " +
                      t +
                      " = " +
                      this[t],
                  );
                ji[t].num && (this[t] = parseFloat(this[t]));
              }
              ji[t].degrees && (this[t] = this[t] * Nt);
            }.bind(this),
          ),
          Math.abs(Math.abs(this.lat0) - xt) < wt
            ? (this.mode = this.lat0 < 0 ? Ti.S_POLE : Ti.N_POLE)
            : Math.abs(this.lat0) < wt
              ? (this.mode = Ti.EQUIT)
              : ((this.mode = Ti.OBLIQ),
                (this.sinph0 = Math.sin(this.lat0)),
                (this.cosph0 = Math.cos(this.lat0))),
          (this.pn1 = this.h / this.a),
          this.pn1 <= 0 || this.pn1 > 1e10)
        )
          throw new Error("Invalid height");
        (this.p = 1 + this.pn1),
          (this.rp = 1 / this.p),
          (this.h1 = 1 / this.pn1),
          (this.pfact = (this.p + 1) * this.h1),
          (this.es = 0);
        var t = this.tilt,
          s = this.azi;
        (this.cg = Math.cos(s)),
          (this.sg = Math.sin(s)),
          (this.cw = Math.cos(t)),
          (this.sw = Math.sin(t));
      },
      forward: function (t) {
        t.x -= this.long0;
        var s,
          i,
          a = Math.sin(t.y),
          h = Math.cos(t.y),
          e = Math.cos(t.x);
        switch (this.mode) {
          case Ti.OBLIQ:
            i = this.sinph0 * a + this.cosph0 * h * e;
            break;
          case Ti.EQUIT:
            i = h * e;
            break;
          case Ti.S_POLE:
            i = -a;
            break;
          case Ti.N_POLE:
            i = a;
        }
        switch (
          ((i = this.pn1 / (this.p - i)),
          (s = i * h * Math.sin(t.x)),
          this.mode)
        ) {
          case Ti.OBLIQ:
            i *= this.cosph0 * a - this.sinph0 * h * e;
            break;
          case Ti.EQUIT:
            i *= a;
            break;
          case Ti.N_POLE:
            i *= -h * e;
            break;
          case Ti.S_POLE:
            i *= h * e;
        }
        var n, r;
        return (
          (n = i * this.cg + s * this.sg),
          (r = 1 / (n * this.sw * this.h1 + this.cw)),
          (s = (s * this.cg - i * this.sg) * this.cw * r),
          (i = n * r),
          (t.x = s * this.a),
          (t.y = i * this.a),
          t
        );
      },
      inverse: function (t) {
        (t.x /= this.a), (t.y /= this.a);
        var s,
          i,
          a,
          h = { x: t.x, y: t.y };
        (a = 1 / (this.pn1 - t.y * this.sw)),
          (s = this.pn1 * t.x * a),
          (i = this.pn1 * t.y * this.cw * a),
          (t.x = s * this.cg + i * this.sg),
          (t.y = i * this.cg - s * this.sg);
        var e = ws(t.x, t.y);
        if (Math.abs(e) < wt) (h.x = 0), (h.y = t.y);
        else {
          var n, r;
          switch (
            ((r = 1 - e * e * this.pfact),
            (r = (this.p - Math.sqrt(r)) / (this.pn1 / e + e / this.pn1)),
            (n = Math.sqrt(1 - r * r)),
            this.mode)
          ) {
            case Ti.OBLIQ:
              (h.y = Math.asin(n * this.sinph0 + (t.y * r * this.cosph0) / e)),
                (t.y = (n - this.sinph0 * Math.sin(h.y)) * e),
                (t.x *= r * this.cosph0);
              break;
            case Ti.EQUIT:
              (h.y = Math.asin((t.y * r) / e)), (t.y = n * e), (t.x *= r);
              break;
            case Ti.N_POLE:
              (h.y = Math.asin(n)), (t.y = -t.y);
              break;
            case Ti.S_POLE:
              h.y = -Math.asin(n);
          }
          h.x = Math.atan2(t.x, t.y);
        }
        return (t.x = h.x + this.long0), (t.y = h.y), t;
      },
      names: ["Tilted_Perspective", "tpers"],
    },
    zi = {
      init: function () {
        if (
          ((this.flip_axis = "x" === this.sweep ? 1 : 0),
          (this.h = Number(this.h)),
          (this.radius_g_1 = this.h / this.a),
          this.radius_g_1 <= 0 || this.radius_g_1 > 1e10)
        )
          throw new Error();
        if (
          ((this.radius_g = 1 + this.radius_g_1),
          (this.C = this.radius_g * this.radius_g - 1),
          0 !== this.es)
        ) {
          var t = 1 - this.es,
            s = 1 / t;
          (this.radius_p = Math.sqrt(t)),
            (this.radius_p2 = t),
            (this.radius_p_inv2 = s),
            (this.shape = "ellipse");
        } else
          (this.radius_p = 1),
            (this.radius_p2 = 1),
            (this.radius_p_inv2 = 1),
            (this.shape = "sphere");
        this.title || (this.title = "Geostationary Satellite View");
      },
      forward: function (t) {
        var s,
          i,
          a,
          h,
          e = t.x,
          n = t.y;
        if (((e -= this.long0), "ellipse" === this.shape)) {
          n = Math.atan(this.radius_p2 * Math.tan(n));
          var r = this.radius_p / ws(this.radius_p * Math.cos(n), Math.sin(n));
          if (
            ((i = r * Math.cos(e) * Math.cos(n)),
            (a = r * Math.sin(e) * Math.cos(n)),
            (h = r * Math.sin(n)),
            (this.radius_g - i) * i - a * a - h * h * this.radius_p_inv2 < 0)
          )
            return (t.x = Number.NaN), (t.y = Number.NaN), t;
          (s = this.radius_g - i),
            this.flip_axis
              ? ((t.x = this.radius_g_1 * Math.atan(a / ws(h, s))),
                (t.y = this.radius_g_1 * Math.atan(h / s)))
              : ((t.x = this.radius_g_1 * Math.atan(a / s)),
                (t.y = this.radius_g_1 * Math.atan(h / ws(a, s))));
        } else
          "sphere" === this.shape &&
            ((s = Math.cos(n)),
            (i = Math.cos(e) * s),
            (a = Math.sin(e) * s),
            (h = Math.sin(n)),
            (s = this.radius_g - i),
            this.flip_axis
              ? ((t.x = this.radius_g_1 * Math.atan(a / ws(h, s))),
                (t.y = this.radius_g_1 * Math.atan(h / s)))
              : ((t.x = this.radius_g_1 * Math.atan(a / s)),
                (t.y = this.radius_g_1 * Math.atan(h / ws(a, s)))));
        return (t.x = t.x * this.a), (t.y = t.y * this.a), t;
      },
      inverse: function (t) {
        var s,
          i,
          a,
          h,
          e = -1,
          n = 0,
          r = 0;
        if (
          ((t.x = t.x / this.a), (t.y = t.y / this.a), "ellipse" === this.shape)
        ) {
          this.flip_axis
            ? ((r = Math.tan(t.y / this.radius_g_1)),
              (n = Math.tan(t.x / this.radius_g_1) * ws(1, r)))
            : ((n = Math.tan(t.x / this.radius_g_1)),
              (r = Math.tan(t.y / this.radius_g_1) * ws(1, n)));
          var o = r / this.radius_p;
          if (
            ((s = n * n + o * o + e * e),
            (i = 2 * this.radius_g * e),
            (a = i * i - 4 * s * this.C) < 0)
          )
            return (t.x = Number.NaN), (t.y = Number.NaN), t;
          (h = (-i - Math.sqrt(a)) / (2 * s)),
            (e = this.radius_g + h * e),
            (n *= h),
            (r *= h),
            (t.x = Math.atan2(n, e)),
            (t.y = Math.atan((r * Math.cos(t.x)) / e)),
            (t.y = Math.atan(this.radius_p_inv2 * Math.tan(t.y)));
        } else if ("sphere" === this.shape) {
          if (
            (this.flip_axis
              ? ((r = Math.tan(t.y / this.radius_g_1)),
                (n = Math.tan(t.x / this.radius_g_1) * Math.sqrt(1 + r * r)))
              : ((n = Math.tan(t.x / this.radius_g_1)),
                (r = Math.tan(t.y / this.radius_g_1) * Math.sqrt(1 + n * n))),
            (s = n * n + r * r + e * e),
            (i = 2 * this.radius_g * e),
            (a = i * i - 4 * s * this.C) < 0)
          )
            return (t.x = Number.NaN), (t.y = Number.NaN), t;
          (h = (-i - Math.sqrt(a)) / (2 * s)),
            (e = this.radius_g + h * e),
            (n *= h),
            (r *= h),
            (t.x = Math.atan2(n, e)),
            (t.y = Math.atan((r * Math.cos(t.x)) / e));
        }
        return (t.x = t.x + this.long0), t;
      },
      names: [
        "Geostationary Satellite View",
        "Geostationary_Satellite",
        "geos",
      ],
    },
    Fi = 1.340264,
    Di = -0.081106,
    Ui = 893e-6,
    Qi = 0.003796,
    Wi = Math.sqrt(3) / 2,
    Hi = {
      init: function () {
        (this.es = 0), (this.long0 = void 0 !== this.long0 ? this.long0 : 0);
      },
      forward: function (t) {
        var s = Ht(t.x - this.long0),
          i = t.y,
          a = Math.asin(Wi * Math.sin(i)),
          h = a * a,
          e = h * h * h;
        return (
          (t.x =
            (s * Math.cos(a)) /
            (Wi * (Fi + 3 * Di * h + e * (7 * Ui + 9 * Qi * h)))),
          (t.y = a * (Fi + Di * h + e * (Ui + Qi * h))),
          (t.x = this.a * t.x + this.x0),
          (t.y = this.a * t.y + this.y0),
          t
        );
      },
      inverse: function (t) {
        (t.x = (t.x - this.x0) / this.a), (t.y = (t.y - this.y0) / this.a);
        var s,
          i,
          a,
          h,
          e,
          n,
          r = t.y;
        for (
          n = 0;
          n < 12 &&
          ((s = r * r),
          (i = s * s * s),
          (a = r * (Fi + Di * s + i * (Ui + Qi * s)) - t.y),
          (h = Fi + 3 * Di * s + i * (7 * Ui + 9 * Qi * s)),
          (r -= e = a / h),
          !(Math.abs(e) < 1e-9));
          ++n
        );
        return (
          (s = r * r),
          (i = s * s * s),
          (t.x =
            (Wi * t.x * (Fi + 3 * Di * s + i * (7 * Ui + 9 * Qi * s))) /
            Math.cos(r)),
          (t.y = Math.asin(Math.sin(r) / Wi)),
          (t.x = Ht(t.x + this.long0)),
          t
        );
      },
      names: ["eqearth", "Equal Earth", "Equal_Earth"],
    };
  return (
    (W.defaultDatum = "WGS84"),
    (W.Proj = Projection),
    (W.WGS84 = new W.Proj("WGS84")),
    (W.Point = Point),
    (W.toPoint = es),
    (W.defs = o),
    (W.nadgrid = function (t, s) {
      var i = new DataView(s),
        a = N(i),
        h = E(i, a),
        e = { header: h, subgrids: C(i, h, a) };
      return (is[t] = e), e;
    }),
    (W.transform = D),
    (W.mgrs = ms),
    (W.version = "2.11.0"),
    (function (proj4) {
      proj4.Proj.projections.add(vs),
        proj4.Proj.projections.add(Is),
        proj4.Proj.projections.add(ks),
        proj4.Proj.projections.add(Gs),
        proj4.Proj.projections.add(Ts),
        proj4.Proj.projections.add(js),
        proj4.Proj.projections.add(zs),
        proj4.Proj.projections.add(Fs),
        proj4.Proj.projections.add(Ds),
        proj4.Proj.projections.add(Zs),
        proj4.Proj.projections.add(ei),
        proj4.Proj.projections.add(ri),
        proj4.Proj.projections.add(oi),
        proj4.Proj.projections.add(ui),
        proj4.Proj.projections.add(ci),
        proj4.Proj.projections.add(fi),
        proj4.Proj.projections.add(di),
        proj4.Proj.projections.add(pi),
        proj4.Proj.projections.add(yi),
        proj4.Proj.projections.add(_i),
        proj4.Proj.projections.add(xi),
        proj4.Proj.projections.add(gi),
        proj4.Proj.projections.add(vi),
        proj4.Proj.projections.add(bi),
        proj4.Proj.projections.add(Ei),
        proj4.Proj.projections.add(Li),
        proj4.Proj.projections.add(Gi),
        proj4.Proj.projections.add(Bi),
        proj4.Proj.projections.add(zi),
        proj4.Proj.projections.add(Hi);
    })(W),
    W
  );
});

window.mat4 = glMatrix.mat4;
window.vec2 = glMatrix.vec2;
window.vec3 = glMatrix.vec3;

// read in 512KB slices
var chunk_size = 512 * 1024;

var strict = false;
var options = {
  trim: false,
  normalize: false,
  xmlns: false,
  position: false,
  strictEntities: true,
};

const State = {
  SEARCH_FOR_SURFACE_OR_GEOMETRY: 0,
  READ_COORDINATES: 3,
};

var currentState = State.SEARCH_FOR_SURFACE_OR_GEOMETRY;
var color = [1.0, 1.0, 1.0];
var axis = vec3.fromValues(19, 0.8, 1.5);
vec3.normalize(axis, axis);
const SCROLL_PERCENTAGE = 0.001;

var parserFile;
var fileSize;
var offset = 0;
var currentPolygon = [];
var coordinateString = "";
var triangulatedPolygons = [];
var viewing;
var bbox;
var clearColor = new Float32Array([1.0, 1.0, 1.0, 1.0]);
var clearDepth = new Float32Array([1.0]);
var camera;
var width = 0;
var height = 0;
var skipFirstResizeEvent = false;
var mouseX;
var mouseY;

var fromProjection;
var toProjection;

var canvas = document.getElementById("viewport");
var progress = document.getElementById("progress");
var gl = canvas.getContext("webgl2", { antialias: true });
var isWebGL2 = !!gl;
if (!isWebGL2) {
  alert(
    'WebGL 2 is not available.  See https://www.khronos.org/webgl/wiki/Getting_a_WebGL_Implementation">How to get a WebGL 2 implementation',
  );
}

canvas.oncontextmenu = function () {
  return false;
};

canvas.onwheel = function (event) {
  if (camera === undefined) {
    return;
  }
  event.preventDefault();
  camera.scroll(event.deltaY);
  redraw(gl);
};

canvas.onmousedown = function (event) {
  if (camera === undefined) {
    return;
  }
  event.preventDefault();
  if (event.buttons === 1 || event.buttons === 2) {
    mouseX = event.layerX;
    mouseY = event.layerY;
  }
};

canvas.onmousemove = function (event) {
  if (camera === undefined) {
    return;
  }
  event.preventDefault();
  if (event.buttons === 1) {
    var deltaX = event.layerX - mouseX;
    var deltaY = event.layerY - mouseY;
    mouseX = event.layerX;
    mouseY = event.layerY;
    camera.rotate(deltaX, deltaY);
    redraw(gl);
  } else if (event.buttons === 2) {
    var deltaX = event.layerX - mouseX;
    var deltaY = event.layerY - mouseY;
    mouseX = event.layerX;
    mouseY = event.layerY;
    camera.move(deltaX, deltaY);
    redraw(gl);
  }
};

const resizeObserver = new ResizeObserver((entries) => {
  if (skipFirstResizeEvent) {
    skipFirstResizeEvent = false;
    return;
  }
  for (let entry of entries) {
    if (entry.contentBoxSize) {
      if (entry.contentBoxSize[0]) {
        height = entry.contentBoxSize[0].blockSize;
        width = entry.contentBoxSize[0].inlineSize;
      } else {
        height = entry.contentBoxSize.blockSize;
        width = entry.contentBoxSize.inlineSize;
      }
    } else {
      width = entry.contentRect.width;
      height = entry.contentRect.height;
    }
  }
  resizeObserver.unobserve(canvas);
  skipFirstResizeEvent = true;
  canvas.height = height;
  canvas.width = width;
  resizeObserver.observe(canvas);
  if (camera === undefined) {
    return;
  }
  gl.viewport(0, 0, width, height);
  camera.reshape(width, height);
  redraw(gl);
});
resizeObserver.observe(canvas);

parser = sax.parser(strict, options);

parser.ontext = function (t) {
  if (currentState === State.READ_COORDINATES) {
    coordinateString += t;
  }
};

parser.onattribute = function (attr) {
  if (attr.name === "SRSNAME") {
    fromProjection = proj4("EPSG:4326");
    if (fromProjection.oProj.units === "degrees") {
    }
  }
};

parser.onopentag = function (node) {
  var tagName = node.name.substring(node.name.indexOf(":") + 1);
  switch (currentState) {
    case State.SEARCH_FOR_SURFACE_OR_GEOMETRY:
      var tempColor = getColorForTagName(tagName);
      if (tempColor !== undefined) {
        color = tempColor;
      } else if (tagName.startsWith("LOD")) {
        var lodChar = tagName.charAt(3);
        if (lodChar === "1") {
        } else if (lodChar === "2") {
        } else if (lodChar === "3") {
        } else if (lodChar === "4") {
        } else if (lodChar === "0") {
        }
      } else if (tagName === "EXTERIOR" || tagName === "INTERIOR") {
        currentState = State.READ_COORDINATES;
      }
      break;
  }
};

function getColorForTagName(tagName) {
  switch (tagName) {
    case "GROUNDSURFACE":
      return [0.9411765, 0.9019608, 0.54901963];
    case "ROOFSURFACE":
      return [1.0, 0.0, 0.0];
    case "DOOR":
      return [1.0, 0.784313, 0.0];
    case "WINDOW":
      return [0.0, 0.5019608, 0.5019608];
    case "WATERBODY":
      return [0.5294118, 0.80784315, 0.98039216];
    case "BRIDGE":
    case "BRIDGEPART":
      return [1, 0.49803922, 0.3137255];
    case "PLANTCOVER":
    case "SOLITARYVEGETATIONOBJECT":
      return [0.5647059, 0.93333334, 0.5647059];
    case "INTERSECTION":
    case "ROAD":
    case "RAILWAY":
    case "SECTION":
    case "SQUARE":
    case "TRACK":
    case "TRANSPORTATIONCOMPLEX":
    case "WATERWAY":
      return [0.4, 0.4, 0.4];
  }
  return undefined;
}

parser.onclosetag = function (node) {
  var tagName = node.substring(node.indexOf(":") + 1);
  switch (currentState) {
    case State.READ_COORDINATES:
      if (tagName === "EXTERIOR" || tagName === "INTERIOR") {
        var split = coordinateString.trim().split(" ");
        var coords = [];
        for (var i = 0; i < split.length; i = i + 3) {
          var x = parseFloat(split[i]);
          var y = parseFloat(split[i + 1]);
          var z = parseFloat(split[i + 2]);
          bbox.expandX(x);
          bbox.expandY(y);
          bbox.expandZ(z);
          coords.push([x, y, z]);
        }
        currentPolygon.push(coords);
        coordinateString = "";
      } else if (tagName === "POLYGON") {
        // no more interior rings
        var triangles = triangulate(currentPolygon);
        var cos = vec3.dot(triangles.normal, axis);
        var acos = Math.acos(cos);
        acos = acos / Math.PI;
        acos = acos * 0.6 + 0.3;
        var derivedColor = [color[0] * acos, color[1] * acos, color[2] * acos];
        var poly = {
          triangles: triangles.vertices,
          color: derivedColor,
        };
        triangulatedPolygons.push(poly);
        currentPolygon = [];
        currentState = State.SEARCH_FOR_SURFACE_OR_GEOMETRY;
      } else if (tagName === "POS") {
        coordinateString += " ";
      } else if (tagName === "SOLID" || tagName === "MULTISURFACE") {
        currentState = State.SEARCH_FOR_SURFACE_OR_GEOMETRY;
      }
      break;
    case State.SEARCH_FOR_SURFACE_OR_GEOMETRY:
      switch (tagName) {
        case "GROUNDSURFACE":
        case "ROOFSURFACE":
        case "DOOR":
        case "WINDOW":
        case "WATERBODY":
        case "BRIDGE":
        case "BRIDGEPART":
        case "PLANTCOVER":
        case "SOLITARYVEGETATIONOBJECT":
        case "INTERSECTION":
        case "ROAD":
        case "RAILWAY":
        case "SECTION":
        case "SQUARE":
        case "TRACK":
        case "TRANSPORTATIONCOMPLEX":
        case "WATERWAY":
          color = [1.0, 1.0, 1.0];
          break;
      }
      break;
  }
};

parser.onend = function () {
  gl.enable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.viewport(0, 0, width, height);

  viewing = [];
  createViewInformation(gl, viewing);
  const vsShader = `#version 300 es
        precision mediump float;

        in vec3 position;
        in vec3 color;
        uniform mat4 projViewModel;
        out vec3 interpolatedColor;

        void main() {
            gl_Position = projViewModel * vec4(position, 1);
            interpolatedColor = color;
        }`;
  const fsShader = `        #version 300 es
        precision mediump float;

        in vec3 interpolatedColor;
        out vec4 outputColor;

        void main() {
            outputColor = vec4(interpolatedColor, 1);
        }`;

  var program = createProgram(
    gl,
    getShaderSourceFromRawString(vsShader),
    getShaderSourceFromRawString(fsShader),
  );
  gl.useProgram(program);
  camera = new Camera(program, gl);
  var cameraViewDistance = 10000;
  camera.reshape(width, height, cameraViewDistance);
  var d = bbox.getDiagonalEdgeLength() / Math.tan(degrees_to_radians(30) / 2);
  var translateZ = -d;
  camera.setDistance(translateZ);
  camera.rotate((Math.PI / 2) * 500, 300);
  document.getElementById("progressDiv").style.display = "none";
  redraw(gl);
};

function createViewInformation(gl, viewing) {
  const center = bbox.getCenter();
  var vertexDataCount = 0;
  for (const poly of triangulatedPolygons) {
    vertexDataCount += poly.triangles.length;
  }
  var vertexData = new Float32Array(vertexDataCount);
  var colorData = new Float32Array(vertexDataCount);
  var elementData = new Float32Array(vertexDataCount / 3);
  var counter = 0;
  for (const poly of triangulatedPolygons) {
    for (var i = 0; i < poly.triangles.length; i++) {
      vertexData[counter] = poly.triangles[i] - center[i % 3];
      colorData[counter] = poly.color[i % 3];
      counter++;
    }
  }
  for (var i = 0; i < elementData.length; i++) {
    elementData[i] = i;
  }
  var viewInformation = {};
  viewInformation.elements = elementData.length;
  viewInformation.draw = true;
  viewInformation.vao = gl.createVertexArray();
  gl.bindVertexArray(viewInformation.vao);

  viewInformation.posVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, viewInformation.posVbo);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.STATIC_DRAW);

  viewInformation.colorVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, viewInformation.colorVbo);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
  gl.bufferData(gl.ARRAY_BUFFER, colorData, gl.STATIC_DRAW);

  viewInformation.indexVbo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, viewInformation.indexVbo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, elementData, gl.STATIC_DRAW);

  gl.bindVertexArray(null);

  viewing.push(viewInformation);
}

function redraw(gl) {
  gl.clearBufferfv(gl.COLOR, 0, clearColor);
  gl.clearBufferfv(gl.DEPTH, 0, clearDepth);

  gl.bindVertexArray(viewing[0].vao);
  gl.drawArrays(gl.TRIANGLES, 0, viewing[0].elements);
}

class BBox {
  constructor() {
    this.lowerCorner = [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    ];
    this.upperCorner = [
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
  }

  expandX(x) {
    if (this.lowerCorner[0] > x) {
      this.lowerCorner[0] = x;
    }
    if (this.upperCorner[0] < x) {
      this.upperCorner[0] = x;
    }
  }

  expandY(y) {
    if (this.lowerCorner[1] > y) {
      this.lowerCorner[1] = y;
    }
    if (this.upperCorner[1] < y) {
      this.upperCorner[1] = y;
    }
  }

  expandZ(z) {
    if (this.lowerCorner[2] > z) {
      this.lowerCorner[2] = z;
    }
    if (this.upperCorner[2] < z) {
      this.upperCorner[2] = z;
    }
  }

  getDiagonalEdgeLength() {
    var xDif = this.upperCorner[0] - this.lowerCorner[0];
    var yDif = this.upperCorner[1] - this.lowerCorner[1];
    var zDif = this.upperCorner[2] - this.lowerCorner[2];
    return Math.sqrt(xDif * xDif + yDif * yDif + zDif * zDif) * 0.2;
  }

  getCenter() {
    var x = (this.upperCorner[0] + this.lowerCorner[0]) / 2.0;
    var y = (this.upperCorner[1] + this.lowerCorner[1]) / 2.0;
    var z = (this.upperCorner[2] + this.lowerCorner[2]) / 2.0;
    return [x, y, z];
  }
}

class Camera {
  constructor(shader, gl) {
    this.gl = gl;
    this.uniformLocation = gl.getUniformLocation(shader, "projViewModel");
    this.up = vec3.create();
    this.up[2] = 1;
    this.distance = 5;
    this.eyepos = vec3.create();
    this.eyepos[0] = this.distance;
    this.centerPos = vec3.create();
    this.projMatrix = mat4.create();
    this.viewMatrix = mat4.create();
    this.projViewMatrix = mat4.create();
    this.rotateAroundZ = 0;
    this.origin = vec3.create();
  }

  reshape(width, height, distance) {
    const fow = Math.PI / 2;
    const aspectRatio = (width * 1.0) / height;
    mat4.perspective(this.projMatrix, fow, aspectRatio, 1, distance);
    this.updateMatrix();
  }

  updateMatrix() {
    mat4.lookAt(this.viewMatrix, this.eyepos, this.centerPos, this.up);
    mat4.multiply(this.projViewMatrix, this.projMatrix, this.viewMatrix);
    this.gl.uniformMatrix4fv(this.uniformLocation, false, this.projViewMatrix);
  }

  rotate(dragDiffX, dragDiffY) {
    var rotationX = (-dragDiffX * 1.0) / 500;
    var rotationZ = (-dragDiffY * 1.0) / 500;
    var tempRotationValue = this.rotateAroundZ + rotationZ;
    if (
      tempRotationValue < -Math.PI / 2 + 0.0001 ||
      tempRotationValue > Math.PI / 2 - 0.0001
    ) {
      // to close to 90 degree, stop rotation
      rotationZ = 0;
    }
    this.rotateAroundZ += rotationZ;

    var res = vec3.create();
    vec3.sub(res, this.eyepos, this.centerPos);
    vec3.rotateZ(res, res, this.origin, rotationX);

    var rotAxis = vec3.fromValues(res[0], res[1], res[2] + 5);
    vec3.cross(rotAxis, rotAxis, res);
    vec3.normalize(rotAxis, rotAxis);
    this.rotateAroundAxis(res, rotationZ, rotAxis[0], rotAxis[1], rotAxis[2]);
    vec3.add(this.eyepos, this.centerPos, res);
    this.updateMatrix();
  }

  rotateAroundAxis(vector, angle, aX, aY, aZ) {
    var hangle = angle * 0.5;
    var sinAngle = Math.sin(hangle);
    var qx = aX * sinAngle,
      qy = aY * sinAngle,
      qz = aZ * sinAngle;
    var qw = Math.cos(hangle);
    var w2 = qw * qw,
      x2 = qx * qx,
      y2 = qy * qy,
      z2 = qz * qz,
      zw = qz * qw;
    var xy = qx * qy,
      xz = qx * qz,
      yw = qy * qw,
      yz = qy * qz,
      xw = qx * qw;
    var x = vector[0],
      y = vector[1],
      z = vector[2];
    vector[0] =
      (w2 + x2 - z2 - y2) * x +
      (-zw + xy - zw + xy) * y +
      (yw + xz + xz + yw) * z;
    vector[1] =
      (xy + zw + zw + xy) * x +
      (y2 - z2 + w2 - x2) * y +
      (yz + yz - xw - xw) * z;
    vector[2] =
      (xz - yw + xz - yw) * x +
      (yz + yz + xw + xw) * y +
      (z2 - y2 - x2 + w2) * z;
  }

  setDistance(distance) {
    this.distance = distance;
    var res = vec3.create();
    vec3.subtract(res, this.centerPos, this.eyepos);
    vec3.normalize(res, res);
    vec3.scale(res, res, this.distance);
    vec3.add(this.eyepos, res, this.centerPos);
    this.updateMatrix();
  }

  scroll(scroll) {
    var addedDistance = this.distance * scroll * SCROLL_PERCENTAGE;
    this.distance += addedDistance;
    this.setDistance(this.distance);
  }

  move(dragDiffX, dragDiffY) {
    var res = vec3.create();
    vec3.sub(res, this.centerPos, this.eyepos);
    var dir = vec2.fromValues(res[0], res[1]);
    vec2.normalize(dir, dir);
    var yDrag = vec2.create();
    vec2.scale(yDrag, dir, dragDiffY * 0.5);

    // handle diffY
    vec3.add(
      this.centerPos,
      this.centerPos,
      vec3.fromValues(yDrag[0], yDrag[1], 0),
    );
    vec3.add(this.eyepos, this.eyepos, vec3.fromValues(yDrag[0], yDrag[1], 0));
    // handle diffX
    var temp = dir[0];
    dir[0] = dir[1];
    dir[1] = -temp;
    vec2.scale(dir, dir, -dragDiffX * 0.5);

    vec3.add(
      this.centerPos,
      this.centerPos,
      vec3.fromValues(dir[0], dir[1], 0),
    );
    vec3.add(this.eyepos, this.eyepos, vec3.fromValues(dir[0], dir[1], 0));
    this.updateMatrix();
  }
}

function degrees_to_radians(degrees) {
  // Store the value of pi.
  var pi = Math.PI;
  // Multiply degrees by pi divided by 180 to convert to radians.
  return degrees * (pi / 180);
}

function getShaderSource(id) {
  var content = document.getElementById(id).textContent;
  return content.replace(/^\s+|\s+$/g, "");
}
function getShaderSourceFromRawString(content) {
  return content.replace(/^\s+|\s+$/g, "");
}

function createShader(gl, source, type) {
  var shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

function createProgram(gl, vertexShaderSource, fragmentShaderSource) {
  var program = gl.createProgram();
  var vshader = createShader(gl, vertexShaderSource, gl.VERTEX_SHADER);
  var fshader = createShader(gl, fragmentShaderSource, gl.FRAGMENT_SHADER);
  gl.attachShader(program, vshader);
  gl.deleteShader(vshader);
  gl.attachShader(program, fshader);
  gl.deleteShader(fshader);
  gl.linkProgram(program);
  return program;
}

/*
var input = document.getElementById("input");
input.addEventListener("change", async function () {
  if (this.files && this.files[0]) {
    const url = getParamValue("url");
    const blob = await fetch(url).then((r) => r.blob());

    camera = undefined;
    //parserFile = this.files[0];
    const fileName = url.indexOf("terrain") > 0 ? "terrain" : "lod2";
    parserFile = blobToFile(blob, fileName);

    fileSize = parserFile.size;
    if (parserFile.name.startsWith("terrain")) {
      color = [1.0, 1.0, 1.0];
    } else {
      color = [0.0, 0.447, 0.807];
    }
    offset = 0;
    bbox = new BBox();
    setProgress(0);
    document.getElementById("progressDiv").style.removeProperty("display");
    readSlice();
  }
});
*/

function blobToFile(theBlob, fileName) {
  //A Blob() is almost a File() - it's just missing the two properties below which we will add
  theBlob.lastModifiedDate = new Date();
  theBlob.name = fileName;
  return theBlob;
}

function setProgress(progressValue) {
  if (progressValue > 1) {
    progressValue = 1;
  }
  progressValue = Math.floor(progressValue * 100);
  var fn = function () {
    progress.setAttribute("style", "width: " + Number(progressValue) + "%");
    progress.ariaValueNow = progressValue;
    progress.innerHTML = progressValue + "%";
  };
  setTimeout(fn);
}

function readSlice() {
  setProgress((offset * 1.0) / fileSize);
  if (offset >= fileSize) {
    // nothing to read anymore
    parser.close();
    return;
  }
  var blob = parserFile.slice(offset, offset + chunk_size);
  offset += chunk_size;
  blob.text().then((t) => {
    parser.write(t);
    readSlice();
  });
}

function triangulate(polygon) {
  var triangleVerts = [];
  tessy.gluTessBeginPolygon(triangleVerts);
  var exterior = polygon[0];
  var normal = calculateNormal(polygon[0]);
  tessy.gluTessNormal(normal[0], normal[1], normal[2]);
  tessy.gluTessBeginContour();
  var contour = polygon[i];
  for (var j = 0; j < exterior.length; j++) {
    tessy.gluTessVertex(exterior[j], exterior[j]);
  }
  tessy.gluTessEndContour();

  for (var i = 1; i < polygon.length; i++) {
    tessy.gluTessBeginContour();
    var contour = polygon[i];
    for (var j = 0; j < contour.length; j++) {
      tessy.gluTessVertex(contour[j], contour[j]);
    }
    tessy.gluTessEndContour();
  }
  tessy.gluTessEndPolygon();
  return {
    vertices: triangleVerts,
    normal: normal,
  };
}

function calculateNormal(ring) {
  var coords = [0, 0, 0];
  for (var i = 0; i < ring.length - 1; i++) {
    var current = ring[i + 0];
    var next = ring[i + 1];
    coords[0] += (current[2] + next[2]) * (current[1] - next[1]);
    coords[1] += (current[0] + next[0]) * (current[2] - next[2]);
    coords[2] += (current[1] + next[1]) * (current[0] - next[0]);
  }

  if (coords[0] == 0 && coords[1] == 0 && coords[2] == 0) {
    // no valid normal vector found
    if (ring.length < 3) {
      // no three points, return x-axis
      return vec3.create([1, 0, 0]);
    }

    var v1 = ring[0];
    var v2 = ring[1];
    var v3 = ring[2];
    return calculateNormalWithCross(
      vec3.create(v1),
      vec3.create(v2),
      vec3.create(v3),
    );
  }
  var v = vec3.fromValues(coords[0], coords[1], coords[2]);
  vec3.normalize(v, v);
  return v;
}

function calculateNormalWithCross(v1, v2, v3) {
  var dir1 = vec3.create();
  vec3.sub(dir1, v2, v1);
  var dir2 = vec3.create();
  vec3.sub(dir2, v3, v1);
  var cross = vec3.create();
  vec3.cross(cross, dir1, dir2);
  vec3.normalize(cross, cross);
  return cross;
}

var tessy = (function initTesselator() {
  // function called for each vertex of tesselator output
  function vertexCallback(data, polyVertArray) {
    polyVertArray[polyVertArray.length] = data[0];
    polyVertArray[polyVertArray.length] = data[1];
    polyVertArray[polyVertArray.length] = data[2];
  }
  function begincallback(type) {}
  function errorcallback(errno) {}
  // callback for when segments intersect and must be split
  function combinecallback(coords, data, weight) {
    return [coords[0], coords[1], coords[2]];
  }
  function edgeCallback(flag) {
    // don't really care about the flag, but need no-strip/no-fan behavior
  }

  var tessy = new libtess.GluTesselator();
  tessy.gluTessCallback(libtess.gluEnum.GLU_TESS_VERTEX_DATA, vertexCallback);
  tessy.gluTessCallback(libtess.gluEnum.GLU_TESS_BEGIN, begincallback);
  tessy.gluTessCallback(libtess.gluEnum.GLU_TESS_ERROR, errorcallback);
  tessy.gluTessCallback(libtess.gluEnum.GLU_TESS_COMBINE, combinecallback);
  tessy.gluTessCallback(libtess.gluEnum.GLU_TESS_EDGE_FLAG, edgeCallback);

  return tessy;
})();

function getParamValue(paramName) {
  var url = window.location.search.substring(1); //get rid of "?" in querystring

  return url.substring(4);

  var qArray = url.split("&"); //get key-value pairs
  for (var i = 0; i < qArray.length; i++) {
    var pArr = qArray[i].split("="); //split key and value
    if (pArr[0] == paramName) return pArr[1]; //return value
  }
}

const url = getParamValue("url");

fetch(url)
  .then((r) => r.blob())
  .then((blob) => {
    displayCitGml(blob, "terrain");
  })
  .then(() => {
    fetch(url.replace("terrain", "lod2"))
      .then((r) => r.blob())
      .then((blob) => {
        displayCitGml(blob, "lod2");
      });
  });

function displayCitGml(blob, gmlType) {
  camera = undefined;
  parserFile = blobToFile(blob, gmlType);

  fileSize = parserFile.size;
  if (gmlType == "terrain") {
    color = [1.0, 1.0, 1.0];
  } else {
    color = [0.0, 0.447, 0.807];
  }
  offset = 0;
  bbox = new BBox();
  setProgress(0);
  document.getElementById("progressDiv").style.removeProperty("display");
  readSlice();
}
