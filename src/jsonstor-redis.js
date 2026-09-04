'use strict';

const jsongin = require( '@liquicode/jsongin' );
const REDIS = require( 'redis' );
const DRIVER_PACKAGE = require( 'redis/package.json' );


//---------------------------------------------------------------------
// ***One hash per collection, and the collection name is the key.***
//
// The alternative was a key per document plus a set of ids to enumerate them, and it loses on
// every axis this family cares about. `SCAN MATCH collection:*` is not an index lookup - it
// walks the whole keyspace and applies the pattern afterwards, so enumerating a hundred
// documents in a database holding a million keys costs a million keys. ***A hash is scoped by
// construction***: `HSCAN` visits this collection and nothing else.
//
// The decisive property is not speed though, it is that ***there is nothing to keep in step***.
// A two key layout has a state where the id set and the documents disagree - a crash between
// the two writes - which means a repair path, which means a way to be silently wrong. One key
// has no such state.
//
// What it gives up: a per-document TTL, which jsonstor has no concept of, and a spread across
// cluster slots, which is out of scope. See jsonx/.plans/wave-2-key-value.md.


//---------------------------------------------------------------------
// ***How many fields a single HSCAN round trip asks for.***
//
// `COUNT` is a hint rather than a limit, and the reply carries fields ***and*** values
// together - so a scan costs one round trip per batch rather than one per document. That
// distinction is the whole of the N+1 lesson this family already paid for in `jsonstor-mssql`,
// where a connection per statement measured 34ms against 3.8ms. There is no reason to buy it
// twice.
const SCAN_BATCH = 1000;


//---------------------------------------------------------------------
// ***How long to wait for a server which is not refusing but is not answering either.***
//
// A closed port answers `ECONNREFUSED` at once and needs no timeout; an address which drops the
// packets answers nothing, and that is the case this bounds. Without it such a storage waits on
// the operating system's own connect timeout, which is minutes.
const CONNECT_TIMEOUT_MS = 5000;


//---------------------------------------------------------------------
// ***One held client per endpoint, shared by every storage which names it.***
//
// Keyed by the connection's four identifying settings rather than by the collection, because
// a storage is one collection and a server holds many: two storages naming one server is the
// ordinary case. Memoized as a promise so that two concurrent first calls await one connect
// instead of racing to open a second.
//
// ***A failed connect is forgotten.*** A remembered failure would answer an empty collection
// for the life of the process, which is a plausible answer rather than a failure - the exact
// shape of the `update_catalog` defect `004) Unreachable Storage Tests` exists to catch.
const HELD_CLIENTS = {};


//---------------------------------------------------------------------
// ***A counter which makes a document key unique inside one process.***
//
// The key carries the document's position in the natural order and is built from the clock, so
// two documents written in the same nanosecond would otherwise collide - and a colliding field
// silently replaces a document rather than failing. `jsonstor-leveldb` closes the same exposure
// the same way, and `jsonstor-folder` has it open in its file names.
let key_sequence = 0;


//---------------------------------------------------------------------
// ***The index is a hash beside the documents, not fields inside them.***
//
// A field in the document hash would be counted by `HLEN` and walked by `HSCAN`, so the O(1)
// count would start lying and every scan would have to filter the index back out. A second key
// costs one `DEL` at drop time and keeps both of those exactly as they were.
//
// ***This is why the clock field survives.*** Keying documents by the identifier instead would
// have bought uniqueness and spent the natural order, which is the trade jsonstor-leveldb
// records at the same place - and the two halves of this wave have to agree about what a
// collection's natural order is.
const INDEX_SEPARATOR = String.fromCharCode( 1 );
const INDEX_SUFFIX = INDEX_SEPARATOR + 'jsonstor_index';

// ***The one field which records that a lookup can no longer be trusted.***
//
// jsongin matches `{ _id: 'x' }` against a document whose identifier is `[ 'x' ]`, by the array
// element rule every operator obeys - so an index filed under the array cannot answer that
// criteria, and neither can a hit on the scalar, because it would answer with one of the two
// documents and report success. A collection holding one is scanned instead.
//
// An encoded identifier always carries its short type and a colon, so nothing else lands here.
const COMPLEX_KEY_FIELD = '';


module.exports = {

	AdapterName: 'jsonstor-redis',
	AdapterDescription: 'Documents are stored on a Redis or Valkey server.',

	GetAdapter: function ( jsonstor, Settings )
	{


		//=====================================================================
		/*
			Settings = {
				Server: '',          // The name or address of the server.
				Port: 6379,          // The service port.
				Database: 0,         // Which of the numbered databases to use.
				UserName: '',        // The user to connect as. Empty for none.
				Password: '',        // That user's password. Empty for none.
				CollectionName: '',  // The hash which holds this storage's documents.
			}
		*/
		if ( jsongin.ShortType( Settings ) !== 'o' ) { throw new Error( `This adapter requires a Settings parameter.` ); }
		if ( jsongin.ShortType( Settings.Server ) !== 's' ) { throw new Error( `This adapter requires a Settings.Server string parameter.` ); }
		if ( jsongin.ShortType( Settings.CollectionName ) !== 's' ) { throw new Error( `This adapter requires a Settings.CollectionName string parameter.` ); }
		if ( !Settings.CollectionName.length ) { throw new Error( `Settings.CollectionName cannot be empty.` ); }
		// ***The index hash is the collection's name with a suffix***, so a collection name
		// carrying the separator could name another collection's index. Checked rather than
		// assumed, which is what jsonstor-leveldb does with the two bytes bounding its ranges.
		if ( Settings.CollectionName.includes( INDEX_SEPARATOR ) )
		{
			throw new Error( `Settings.CollectionName cannot contain character 1.` );
		}


		//=====================================================================
		let Storage = jsonstor.StorageInterface();
		Storage.Settings = jsongin.Clone( Settings );

		//=====================================================================
		// The key, resolved.
		let key_declaration = jsonstor.PrimaryKey.Resolve( Storage.Settings );
		if ( key_declaration.Fields.length > 1 )
		{
			// ***Declared, not built.*** One index field holds one encoded value, so an adapter
			// which cannot honor a composite key refuses it by name.
			throw new Error( `This adapter does not support a composite PrimaryKey: [${key_declaration.Fields.join( ', ' )}].` );
		}
		if ( key_declaration.Fields.length === 0 ) { key_declaration.Fields = [ jsonstor.PrimaryKey.DEFAULT_FIELD ]; }

		Storage.PrimaryKeyInfo = {
			Fields: key_declaration.Fields,
			// The hash field is the clock, not the identifier, so there is no key column whose
			// type would need declaring. The index carries the encoded value and the document
			// carries the true one.
			Types: [],
			Mutable: key_declaration.Mutable,
			Generated: true,
			// ***jsonstor holds this index, even though it lives on the server.*** Redis has no
			// secondary index of its own; every field here is written by this adapter, which is
			// what makes RefreshIndex real work rather than a no-op.
			IndexHostedBy: 'jsonstor',
		};

		if ( jsongin.ShortType( Storage.Settings.Port ) !== 'n' ) { Storage.Settings.Port = 6379; }
		if ( jsongin.ShortType( Storage.Settings.Database ) !== 'n' ) { Storage.Settings.Database = 0; }
		if ( jsongin.ShortType( Storage.Settings.UserName ) !== 's' ) { Storage.Settings.UserName = ''; }
		if ( jsongin.ShortType( Storage.Settings.Password ) !== 's' ) { Storage.Settings.Password = ''; }
		// ***The two names are the family's, not this driver's.*** `jsonstor-mssql` named these
		// first and the same pair is spelled the same way wherever a driver can carry it. node-redis
		// takes them as socket options, which is where they are mapped.
		//
		// ***Both defaults suit a local server and neither suits a hosted one.*** All five servers
		// in the fleet are plaintext; a hosted Redis or Valkey wants the opposite pair.
		if ( jsongin.ShortType( Storage.Settings.Encrypt ) !== 'b' ) { Storage.Settings.Encrypt = false; }
		if ( jsongin.ShortType( Storage.Settings.TrustServerCertificate ) !== 'b' ) { Storage.Settings.TrustServerCertificate = true; }


		//=====================================================================
		// What the two stages did, for a storage which has no first stage.
		//
		// ***This adapter pushes nothing down, and that is the measurement.*** Redis has no
		// query language - the query engine Redis 8 carries in core is a module surface this
		// wave deliberately does not enter - so there is no clause to build: every document in
		// the collection is handed to jsongin and the criteria is the residual entire.
		// Reporting it makes this comparable with an adapter which does push down.
		//
		// Scanned is the size of the collection rather than the number of documents actually
		// examined, because a read which stops early stopped by luck rather than by a clause.
		function report_scan( Options, Criteria, Scanned, Matched )
		{
			jsonstor.ReportStatistics( Options, {
				Translator: '',
				Pushdown: null,
				PushdownRows: Scanned,
				Residual: ( jsongin.ShortType( Criteria ) === 'o' ) ? Criteria : {},
				ResidualRows: Matched,
			} );
			return;
		}


		//=====================================================================
		// The connection, held and shared.
		//=====================================================================


		//---------------------------------------------------------------------
		// Which held client this storage's settings name.
		function client_key()
		{
			return [
				Storage.Settings.Server,
				Storage.Settings.Port,
				Storage.Settings.Database,
				Storage.Settings.UserName,
			].join( '' );
		}


		//---------------------------------------------------------------------
		function held_client()
		{
			let key = client_key();
			if ( typeof HELD_CLIENTS[ key ] === 'undefined' )
			{
				let options = {
					socket: {
						host: Storage.Settings.Server,
						port: Storage.Settings.Port,
						connectTimeout: CONNECT_TIMEOUT_MS,
						// ***The driver retries forever by default, and that turns an
						// unreachable server into a hang rather than a failure.***
						//
						// Measured on 2026-09-02: with the default strategy, `connect()`
						// against a port this process had just proved closed never settled at
						// all, and `004) Unreachable Storage Tests` timed out at 60s instead of
						// failing. ***That is worse than the plausible answer that suite was
						// written for*** - a read which never returns cannot even be reported.
						//
						// ***Reconnection is this adapter's job rather than the driver's.***
						// A failed client is forgotten above and the next call builds a new
						// one, which is the same recovery `jsonstor-mysql` performs by
						// forgetting a connection that errored. Two layers retrying is how the
						// hang got built.
						reconnectStrategy: false,
					},
					database: Storage.Settings.Database,
				};
				// ***Added rather than set false, the way mysql2 wants it.*** node-redis reads
				// `socket.tls` as the request for TLS, and `rejectUnauthorized` is the inverse of
				// trusting the certificate.
				if ( Storage.Settings.Encrypt )
				{
					options.socket.tls = true;
					options.socket.rejectUnauthorized = !Storage.Settings.TrustServerCertificate;
				}
				// ***Empty means absent rather than blank.*** A server with no ACL refuses a
				// connection which offers an empty user, so the settings are omitted entirely
				// rather than sent as empty strings.
				if ( Storage.Settings.UserName.length ) { options.username = Storage.Settings.UserName; }
				if ( Storage.Settings.Password.length ) { options.password = Storage.Settings.Password; }

				let client = REDIS.createClient( options );
				// ***An unhandled 'error' on a client takes the process down***, and a held
				// client is exactly the one which outlives the command that would otherwise
				// have caught it. Forgetting it here is also what makes a server restart
				// recoverable: the next command opens a new one.
				client.on( 'error',
					function ()
					{
						delete HELD_CLIENTS[ key ];
						return;
					} );

				HELD_CLIENTS[ key ] = client.connect().then(
					function ()
					{
						return client;
					},
					function ( ConnectError )
					{
						delete HELD_CLIENTS[ key ];
						throw ConnectError;
					} );
			}
			return HELD_CLIENTS[ key ];
		}


		//---------------------------------------------------------------------
		// ***The socket does not count towards keeping the event loop alive between commands.***
		//
		// The Storage interface has no Close, so a held client would otherwise hang a finished
		// test run - the same problem `jsonstor-mysql` solved by hand because mysql2 has no
		// `allowExitOnIdle`. node-redis exposes `ref` and `unref` directly, so the rule is the
		// same one written in the driver's own vocabulary.
		//
		// ***The count is what makes it safe.*** Unref'ing while a command is in flight would
		// let the process exit with the answer still on the wire, so the socket is ref'd on the
		// way in and only released when the last concurrent command is done.
		let commands_in_flight = 0;

		async function WithClient( Handler /* ( Client ) */ )
		{
			let client = await held_client();
			if ( commands_in_flight === 0 ) { client.ref(); }
			commands_in_flight++;
			try
			{
				return await Handler( client );
			}
			finally
			{
				commands_in_flight--;
				if ( commands_in_flight === 0 ) { client.unref(); }
			}
		}


		//=====================================================================
		// Keys and documents.
		//=====================================================================


		//---------------------------------------------------------------------
		// The single hash which holds this storage's documents.
		function hash_key()
		{
			return Storage.Settings.CollectionName;
		}


		//---------------------------------------------------------------------
		// The hash holding this storage's index.
		function index_hash_key()
		{
			return Storage.Settings.CollectionName + INDEX_SUFFIX;
		}


		//---------------------------------------------------------------------
		// The encoded identifier a document carries, or null when it carries none.
		function document_key_of( Document )
		{
			return jsonstor.PrimaryKey.DocumentKey( Document, Storage.PrimaryKeyInfo.Fields );
		}


		//---------------------------------------------------------------------
		// Mints an identifier for a document which arrived without one.
		function apply_new_key( Document )
		{
			let field = Storage.PrimaryKeyInfo.Fields[ 0 ];
			let value = jsongin.GetValue( Document, field );
			if ( typeof value !== 'undefined' ) { return; }
			jsongin.SetValue( Document, field, jsonstor.NewUniqueID() );
			return;
		}


		//---------------------------------------------------------------------
		// The HSET arguments which file a document in the index, appended to Command.
		function append_index_writes( Command, Document, DocumentKey )
		{
			let value = jsonstor.PrimaryKey.DocumentValue( Document, Storage.PrimaryKeyInfo.Fields );
			if ( value === null ) { return false; }
			Command.push( jsonstor.PrimaryKey.EncodeValue( value ), DocumentKey );
			if ( !jsonstor.PrimaryKey.IsScalar( value ) ) { Command.push( COMPLEX_KEY_FIELD, '1' ); }
			return true;
		}


		//---------------------------------------------------------------------
		// Writes index entries, if there are any to write.
		async function write_index( Pairs )
		{
			if ( !Pairs.length ) { return; }
			let command = [ 'HSET', index_hash_key() ].concat( Pairs );
			await WithClient(
				async function ( Client )
				{
					return await Client.sendCommand( command );
				} );
			return;
		}


		//---------------------------------------------------------------------
		// Removes index entries, if there are any to remove.
		async function delete_index( Fields )
		{
			if ( !Fields.length ) { return; }
			let command = [ 'HDEL', index_hash_key() ].concat( Fields );
			await WithClient(
				async function ( Client )
				{
					return await Client.sendCommand( command );
				} );
			return;
		}


		//---------------------------------------------------------------------
		// Refuses an identifier which is already in the collection.
		//
		// ***One HGET rather than a scan***, which is the whole reason the index is here.
		async function require_unique( EncodedKey, ExceptDocumentKey )
		{
			if ( EncodedKey === null ) { return; }
			let found = await WithClient(
				async function ( Client )
				{
					return await Client.sendCommand( [ 'HGET', index_hash_key(), EncodedKey ] );
				} );
			if ( found === null ) { return; }
			if ( String( found ) === ExceptDocumentKey ) { return; }
			throw new Error( `A document with this primary key already exists: ${ EncodedKey }.` );
		}


		//---------------------------------------------------------------------
		// Refuses an update or a replace which moved the identifier. See
		// jsonx/.plans/primary-keys-and-indexes.md - refusing is the only one of the three
		// measured behaviors which cannot mislead a caller.
		function check_key_move( Before, After )
		{
			if ( Storage.PrimaryKeyInfo.Mutable ) { return; }
			if ( Before === After ) { return; }
			throw new Error( `The primary key [${Storage.PrimaryKeyInfo.Fields[ 0 ]}] is not mutable, and this operation would change it from [${Before}] to [${After}].` );
		}


		//---------------------------------------------------------------------
		// ***The document a by-key criteria asks for, or null to ask the scan.***
		//
		// Two round trips and no scan: the index answers the document's field, and HGET answers
		// the document. The sentinel is read with the entry rather than after a miss, because a
		// hit is just as wrong as a miss once the collection holds a non-scalar identifier -
		// answering with the hit alone loses a row and reports success.
		async function find_by_index( Criteria )
		{
			let encoded = jsonstor.PrimaryKey.CriteriaKey( Criteria, Storage.PrimaryKeyInfo.Fields );
			if ( encoded === null ) { return null; }
			let reply = await WithClient(
				async function ( Client )
				{
					return await Client.sendCommand( [ 'HMGET', index_hash_key(), COMPLEX_KEY_FIELD, encoded ] );
				} );
			if ( reply[ 0 ] !== null ) { return null; }
			if ( reply[ 1 ] === null ) { return { Entries: [] }; }
			let document_key = String( reply[ 1 ] );
			let value = await WithClient(
				async function ( Client )
				{
					return await Client.sendCommand( [ 'HGET', hash_key(), document_key ] );
				} );
			if ( value === null )
			{
				// ***An index entry with no document behind it.*** Nothing this adapter writes
				// can produce one, so it means the hash was written by something else. Falling
				// through to the scan is the answer which cannot lose a row.
				return null;
			}
			return { Entries: [ { Key: document_key, Document: JSON.parse( value ) } ] };
		}


		//---------------------------------------------------------------------
		// What the index did.
		//
		// ***An index is a pushdown for an adapter with no query language to push down to***, so
		// it reports in the same pair of numbers a WHERE clause does. PushdownRows is one or zero
		// rather than the size of the collection, and that difference is the whole assertion.
		function report_lookup( Options, Criteria, Scanned, Matched )
		{
			jsonstor.ReportStatistics( Options, {
				Translator: '',
				Pushdown: Criteria,
				PushdownRows: Scanned,
				Residual: {},
				ResidualRows: Matched,
			} );
			return;
		}


		//---------------------------------------------------------------------
		// ***A field which sorts in insertion order***, which is this storage's natural order.
		//
		// Every component is padded to a fixed width, because a variable width field sorts
		// lexicographically in a different order than it was written in - '9000000' lands after
		// '564003000'. ***This is the same key `jsonstor-leveldb` builds***, deliberately: the
		// two halves of this wave have to agree about what a collection's natural order is, or
		// the same conformance test measures two different promises.
		function new_document_key()
		{
			let hr_time = process.hrtime();
			let milliseconds = String( ( new Date() ).getTime() ).padStart( 14, '0' );
			let hr_seconds = String( hr_time[ 0 ] ).padStart( 10, '0' );
			let hr_nanoseconds = String( hr_time[ 1 ] ).padStart( 9, '0' );
			key_sequence = ( key_sequence + 1 ) % 1000000;
			let sequence = String( key_sequence ).padStart( 6, '0' );
			return `${milliseconds}.${hr_seconds}.${hr_nanoseconds}.${sequence}`;
		}


		//---------------------------------------------------------------------
		// ***How many documents this collection holds, without reading one.***
		//
		// `HLEN` is O(1) and never touches a value, so the size of a collection is a question
		// the server answers rather than one this process counts.
		async function count_documents()
		{
			return await WithClient(
				async function ( Client )
				{
					return await Client.sendCommand( [ 'HLEN', hash_key() ] );
				} );
		}


		//---------------------------------------------------------------------
		// ***Every document in the collection, in natural order, with the field it is under.***
		//
		// Two things happen here which no ordered store needs, and both are `HSCAN`'s doing:
		//
		// ***A field may be returned twice.*** Redis cursor guarantees are weak by design - an
		// element present for the whole iteration is returned ***at least*** once, not exactly
		// once, because a rehash between round trips can revisit a bucket. A scan handed
		// straight to jsongin would therefore return one document twice. Deduplicating by the
		// field is what closes it, and the field is the right key to use rather than `_id`
		// because the field is what this adapter guarantees unique.
		//
		// ***And the reply has no order at all.*** The ordered stores give sorted keys for free
		// and Redis gives none, so the natural order is imposed here by sorting on the field -
		// which is the clock the document was written at.
		async function read_documents()
		{
			return await WithClient(
				async function ( Client )
				{
					let seen = new Set();
					let entries = [];
					let cursor = '0';
					do
					{
						let reply = await Client.sendCommand( [ 'HSCAN', hash_key(), cursor, 'COUNT', String( SCAN_BATCH ) ] );
						cursor = String( reply[ 0 ] );
						let tuples = reply[ 1 ];
						for ( let index = 0; index < tuples.length; index += 2 )
						{
							let field = String( tuples[ index ] );
							if ( seen.has( field ) ) { continue; }
							seen.add( field );
							entries.push( { Key: field, Document: JSON.parse( tuples[ index + 1 ] ) } );
						}
					}
					while ( cursor !== '0' );
					entries.sort(
						function ( Left, Right )
						{
							if ( Left.Key < Right.Key ) { return -1; }
							if ( Left.Key > Right.Key ) { return 1; }
							return 0;
						} );
					return entries;
				} );
		}


		//---------------------------------------------------------------------
		// ***The first document satisfying Criteria, and the field holding it.***
		//
		// ***This cannot stop early and an ordered store can***, which is the one place the two
		// halves of this wave really differ. "First" means first in the natural order, the
		// natural order is imposed by sorting, and nothing can be sorted until all of it has
		// arrived. So the collection is read whole and then searched - and the cost is honest
		// rather than hidden, because `report_scan` was already reporting the whole collection.
		async function find_first( Criteria )
		{
			let entries = await read_documents();
			let matches_everything = criteria_matches_everything( Criteria );
			for ( let index = 0; index < entries.length; index++ )
			{
				if ( matches_everything || jsongin.Query( entries[ index ].Document, Criteria ) )
				{
					return { Entries: entries, Found: entries[ index ] };
				}
			}
			return { Entries: entries, Found: null };
		}


		//---------------------------------------------------------------------
		// null, undefined and {} all mean "every document".
		function criteria_matches_everything( Criteria )
		{
			let short_type = jsongin.ShortType( Criteria );
			if ( 'lu'.includes( short_type ) ) { return true; }
			if ( Object.keys( Criteria ).length === 0 ) { return true; }
			return false;
		}


		//---------------------------------------------------------------------
		// Criteria this storage will accept at all.
		function check_criteria( Criteria )
		{
			let short_type = jsongin.ShortType( Criteria );
			if ( !'olu'.includes( short_type ) ) { throw new Error( `Criteria must be an object, null, or undefined.` ); }
			return;
		}


		//=====================================================================
		// StorageInfo
		//=====================================================================


		//---------------------------------------------------------------------
		// ***`redis_version` is the wrong field to read, and reading it fails silently.***
		//
		// A Valkey server introduces itself as Redis 7.2.4 - the version it forked from - and
		// ***it keeps saying 7.2.4 forever***. Measured on 2026-09-02: `valkey-v7.2` reports
		// `redis_version:7.2.4` alongside `valkey_version:7.2.14`, and `valkey-v8.1` reports
		// the ***same*** `redis_version:7.2.4` alongside `valkey_version:8.1.10`. So on Valkey
		// that field is a frozen compatibility claim which never moves, and an adapter which
		// reads it does not merely mislabel the product - it reports one constant for every
		// Valkey release there will ever be.
		//
		// ***`server_name` is the only field which distinguishes the products***, and Redis
		// does not emit it at all. That is the discriminator, and `003) Dialect Profile Tests`
		// asserts it so that an adapter which starts reading the wrong field fails rather than
		// quietly mislabelling every Valkey server.
		function read_server_facts( Info )
		{
			let fields = {};
			let lines = String( Info ).split( '\n' );
			for ( let index = 0; index < lines.length; index++ )
			{
				let parts = lines[ index ].trim().split( ':' );
				if ( parts.length === 2 ) { fields[ parts[ 0 ] ] = parts[ 1 ]; }
			}
			let is_valkey = ( fields.server_name === 'valkey' );
			return {
				Product: is_valkey ? 'Valkey' : 'Redis',
				Version: ( is_valkey ? fields.valkey_version : fields.redis_version ) || '',
				CompatibilityVersion: fields.redis_version || '',
			};
		}


		// ***What this storage is actually talking to.***
		Storage.StorageInfo = async function ( Options )
		{
			let info = await WithClient(
				async function ( Client )
				{
					return await Client.sendCommand( [ 'INFO', 'server' ] );
				} );
			let facts = read_server_facts( info );
			// ***The banner carries the compatibility claim where the two differ***, because a
			// Valkey server reporting 8.1.10 is also, truthfully, answering as Redis 7.2.4 -
			// and a reader tracing a version through this family should see both rather than
			// discover the second one from a protocol dump.
			let banner = `${facts.Product} ${facts.Version}`;
			if ( facts.Product === 'Valkey' ) { banner += ` (redis_version ${facts.CompatibilityVersion})`; }
			return jsonstor.BuildStorageInfo( Storage, {
				Product: facts.Product,
				Version: facts.Version,
				Banner: banner,
				Endpoint: `${Storage.Settings.Server}:${Storage.Settings.Port}`,
			} );
		};


		//---------------------------------------------------------------------
		// ***The floor is checked against the server once, on the first operation.***
		//
		// The connection is lazy and `GetStorage` is synchronous, so a server below the floor
		// cannot be caught at construction and surfaces on the first operation instead. ***The
		// outcome is remembered***, so a storage pointed at a server its profile does not cover
		// fails the same way every time rather than only once.
		//
		// ***A server which did not answer is not remembered***, because that is a transient
		// failure rather than an answer, and caching it would poison the storage.
		//
		// Nothing here renders differently per version - this package has one profile covering
		// both products, which is the measurement rather than a simplification - so the check
		// buys a clear message rather than a correct statement. That is still worth one INFO.
		let floor_check = null;
		async function ensure_floor_checked()
		{
			if ( floor_check !== null )
			{
				if ( floor_check.Error ) { throw floor_check.Error; }
				return;
			}
			// Set before asking, so that StorageInfo's own command does not re-enter this.
			floor_check = {};
			try { await Storage.StorageInfo(); }
			catch ( error )
			{
				if ( error && error.DialectBoundary ) { floor_check.Error = error; }
				else { floor_check = null; }
				throw error;
			}
			return;
		}


		//=====================================================================
		// DropStorage
		//=====================================================================


		// ***The collection is dropped and the database is not.***
		//
		// A database holds many collections, so flushing it would take every neighbouring
		// collection with it. The collection is one key, so deleting that key is exactly this
		// storage's documents and nothing else - which is the layout paying out again.
		Storage.DropStorage = async function ( Options )
		{
			await ensure_floor_checked();
			await WithClient(
				async function ( Client )
				{
					// ***Both keys, so the index goes with the documents.*** Dropping only the
					// document hash would leave an index describing a collection which is no
					// longer there, and the next insert would be refused as a duplicate of a
					// document nobody can read.
					return await Client.sendCommand( [ 'DEL', hash_key(), index_hash_key() ] );
				} );
			return true;
		};


		//=====================================================================
		// RefreshIndex
		//=====================================================================


		// ***Rebuilds the index from a full scan, and answers how many entries it filed.***
		//
		// This hash is this adapter's own, so nothing else writes it and the index cannot drift
		// on its own. It is real work rather than a no-op because the index is jsonstor's rather
		// than the server's - Redis has no secondary index to maintain on our behalf - and
		// because a collection written by an older version of this adapter has documents and no
		// index at all. Calling it once brings such a collection up to date.
		Storage.RefreshIndex = async function ( Options )
		{
			await ensure_floor_checked();
			await WithClient(
				async function ( Client )
				{
					return await Client.sendCommand( [ 'DEL', index_hash_key() ] );
				} );
			let entries = await read_documents();
			let pairs = [];
			let filed = 0;
			let seen = {};
			for ( let index = 0; index < entries.length; index++ )
			{
				let value = jsonstor.PrimaryKey.DocumentValue( entries[ index ].Document, Storage.PrimaryKeyInfo.Fields );
				if ( value === null ) { continue; }
				let encoded = jsonstor.PrimaryKey.EncodeValue( value );
				// ***A rebuild reports what it found rather than refusing it.*** A collection may
				// already hold a duplicate, and throwing here would leave the storage unusable
				// with no way to look at what is wrong with it.
				if ( seen[ encoded ] ) { continue; }
				seen[ encoded ] = true;
				append_index_writes( pairs, entries[ index ].Document, entries[ index ].Key );
				filed++;
			}
			await write_index( pairs );
			return filed;
		};


		//=====================================================================
		// FlushStorage
		//=====================================================================


		// Redis decides its own persistence, and no setting of this adapter's changes that, so
		// there is nothing here to force.
		Storage.FlushStorage = async function ( Options )
		{
			await ensure_floor_checked();
			return true;
		};


		//=====================================================================
		// Count
		//=====================================================================


		Storage.Count = async function ( Criteria, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();

			// ***An unfiltered count never reads a document.*** `HLEN` is O(1) on the server,
			// which is this medium's version of the cheap answer every other adapter's count of
			// everything gets from its own.
			if ( criteria_matches_everything( Criteria ) )
			{
				let counted = await count_documents();
				report_scan( Options, Criteria, counted, counted );
				return counted;
			}

			let looked_up = await find_by_index( Criteria );
			let entries = looked_up ? looked_up.Entries : await read_documents();
			let matched = 0;
			for ( let index = 0; index < entries.length; index++ )
			{
				if ( jsongin.Query( entries[ index ].Document, Criteria ) ) { matched++; }
			}
			if ( looked_up ) { report_lookup( Options, Criteria, entries.length, matched ); }
			else { report_scan( Options, Criteria, entries.length, matched ); }
			return matched;
		};


		//=====================================================================
		// InsertOne
		//=====================================================================


		Storage.InsertOne = async function ( Document, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			if ( jsongin.ShortType( Document ) !== 'o' ) { throw new Error( `Document must be an object.` ); }
			await ensure_floor_checked();
			let document = jsongin.Clone( Document );
			apply_new_key( document );
			await require_unique( document_key_of( document ), null );
			let document_key = new_document_key();
			await WithClient(
				async function ( Client )
				{
					return await Client.sendCommand( [ 'HSET', hash_key(), document_key, JSON.stringify( document ) ] );
				} );
			let pairs = [];
			append_index_writes( pairs, document, document_key );
			await write_index( pairs );
			if ( Options.ReturnDocuments ) { return document; }
			return 1;
		};


		//=====================================================================
		// InsertMany
		//=====================================================================


		Storage.InsertMany = async function ( Documents, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			if ( jsongin.ShortType( Documents ) !== 'a' ) { throw new Error( `Documents must be an array of objects.` ); }
			await ensure_floor_checked();
			let command = [ 'HSET', hash_key() ];
			let index_pairs = [];
			let inserted = [];
			for ( let index = 0; index < Documents.length; index++ )
			{
				let document = jsongin.Clone( Documents[ index ] );
				apply_new_key( document );
				// ***A duplicate stops the insert where it stands.*** The HSET is not yet sent,
				// so nothing before it is written either - which is a stronger promise than the
				// scanning adapters can make and comes free from batching.
				await require_unique( document_key_of( document ), null );
				let document_key = new_document_key();
				command.push( document_key, JSON.stringify( document ) );
				append_index_writes( index_pairs, document, document_key );
				inserted.push( document );
			}
			// ***One HSET carrying every pair, rather than one round trip per document.***
			// The same shape as the connection per statement which cost this family a measured
			// 34ms against 3.8ms in `jsonstor-mssql`.
			if ( inserted.length )
			{
				await WithClient(
					async function ( Client )
					{
						return await Client.sendCommand( command );
					} );
				await write_index( index_pairs );
			}
			if ( Options.ReturnDocuments ) { return inserted; }
			return inserted.length;
		};


		//=====================================================================
		// FindOne
		//=====================================================================


		Storage.FindOne = async function ( Criteria, Projection, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			let looked_up = await find_by_index( Criteria );
			if ( looked_up )
			{
				let matched = null;
				for ( let index = 0; index < looked_up.Entries.length; index++ )
				{
					if ( !jsongin.Query( looked_up.Entries[ index ].Document, Criteria ) ) { continue; }
					matched = jsongin.Project( looked_up.Entries[ index ].Document, Projection );
					break;
				}
				report_lookup( Options, Criteria, looked_up.Entries.length, matched ? 1 : 0 );
				return matched;
			}
			let search = await find_first( Criteria );
			let document = null;
			if ( search.Found ) { document = jsongin.Project( search.Found.Document, Projection ); }
			report_scan( Options, Criteria, search.Entries.length, document ? 1 : 0 );
			return document;
		};


		//=====================================================================
		// FindMany
		//=====================================================================


		Storage.FindMany = async function ( Criteria, Projection, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			let looked_up = await find_by_index( Criteria );
			let entries = looked_up ? looked_up.Entries : await read_documents();
			let matches_everything = criteria_matches_everything( Criteria );
			let documents = [];
			for ( let index = 0; index < entries.length; index++ )
			{
				let document = entries[ index ].Document;
				if ( matches_everything || jsongin.Query( document, Criteria ) )
				{
					documents.push( jsongin.Project( document, Projection ) );
				}
			}
			if ( looked_up ) { report_lookup( Options, Criteria, entries.length, documents.length ); }
			else { report_scan( Options, Criteria, entries.length, documents.length ); }
			return documents;
		};


		//=====================================================================
		// FindMany2
		//=====================================================================


		Storage.FindMany2 = async function ( Criteria, Projection, Sort, MaxCount, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			let looked_up = await find_by_index( Criteria );
			let entries = looked_up ? looked_up.Entries : await read_documents();
			let matches_everything = criteria_matches_everything( Criteria );
			let documents = [];
			for ( let index = 0; index < entries.length; index++ )
			{
				let document = entries[ index ].Document;
				if ( matches_everything || jsongin.Query( document, Criteria ) )
				{
					documents.push( jsongin.Project( document, Projection ) );
				}
			}
			if ( Sort ) { documents = jsongin.Sort( documents, Sort ); }
			if ( MaxCount && ( MaxCount > 0 ) && ( documents.length >= MaxCount ) ) { documents = documents.splice( 0, MaxCount ); }
			if ( looked_up ) { report_lookup( Options, Criteria, entries.length, documents.length ); }
			else { report_scan( Options, Criteria, entries.length, documents.length ); }
			return documents;
		};


		//=====================================================================
		// UpdateOne
		//=====================================================================


		Storage.UpdateOne = async function ( Criteria, Updates, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			let search = await find_first( Criteria );
			let modified = null;
			let modified_count = 0;
			if ( search.Found )
			{
				// ***The field does not move when a document is updated***, so a document keeps
				// the position in the natural order it was inserted at. Rewriting it under a
				// fresh field would send it to the end of the collection, which no other
				// adapter does and no caller asked for.
				modified = jsongin.Update( search.Found.Document, Updates );
				let before = document_key_of( search.Found.Document );
				let after = document_key_of( modified );
				check_key_move( before, after );
				if ( before !== after ) { await require_unique( after, search.Found.Key ); }
				await WithClient(
					async function ( Client )
					{
						return await Client.sendCommand( [ 'HSET', hash_key(), search.Found.Key, JSON.stringify( modified ) ] );
					} );
				if ( before !== after )
				{
					if ( before !== null ) { await delete_index( [ before ] ); }
					let pairs = [];
					append_index_writes( pairs, modified, search.Found.Key );
					await write_index( pairs );
				}
				modified_count++;
			}
			if ( Options.ReturnDocuments ) { return modified; }
			return modified_count;
		};


		//=====================================================================
		// UpdateMany
		//=====================================================================


		Storage.UpdateMany = async function ( Criteria, Updates, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			let entries = await read_documents();
			let matches_everything = criteria_matches_everything( Criteria );
			let command = [ 'HSET', hash_key() ];
			let index_pairs = [];
			let index_removals = [];
			let modified = [];
			for ( let index = 0; index < entries.length; index++ )
			{
				let entry = entries[ index ];
				if ( !matches_everything && !jsongin.Query( entry.Document, Criteria ) ) { continue; }
				let document = jsongin.Update( entry.Document, Updates );
				let before = document_key_of( entry.Document );
				let after = document_key_of( document );
				check_key_move( before, after );
				if ( before !== after )
				{
					await require_unique( after, entry.Key );
					if ( before !== null ) { index_removals.push( before ); }
					append_index_writes( index_pairs, document, entry.Key );
				}
				command.push( entry.Key, JSON.stringify( document ) );
				modified.push( document );
			}
			if ( modified.length )
			{
				await WithClient(
					async function ( Client )
					{
						return await Client.sendCommand( command );
					} );
				await delete_index( index_removals );
				await write_index( index_pairs );
			}
			if ( Options.ReturnDocuments ) { return modified; }
			return modified.length;
		};


		//=====================================================================
		// ReplaceOne
		//=====================================================================


		Storage.ReplaceOne = async function ( Criteria, Document, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			if ( jsongin.ShortType( Document ) !== 'o' ) { throw new Error( `Document must be an object.` ); }
			await ensure_floor_checked();
			let search = await find_first( Criteria );
			let modified = null;
			let modified_count = 0;
			if ( search.Found )
			{
				modified = jsongin.Clone( Document );
				// ***A replacement with no primary key carries the matched document's key
				// over.*** This adapter used to throw here, which was one of three behaviors
				// across the family - four adapters threw, three changed the key, six kept it -
				// and the guide's own documented example is the shape which threw.
				let key_field = Storage.PrimaryKeyInfo.Fields[ 0 ];
				if ( typeof jsongin.GetValue( modified, key_field ) === 'undefined' )
				{
					let carried = jsongin.GetValue( search.Found.Document, key_field );
					if ( typeof carried !== 'undefined' ) { jsongin.SetValue( modified, key_field, carried ); }
				}
				let before = document_key_of( search.Found.Document );
				let after = document_key_of( modified );
				check_key_move( before, after );
				if ( before !== after ) { await require_unique( after, search.Found.Key ); }
				await WithClient(
					async function ( Client )
					{
						return await Client.sendCommand( [ 'HSET', hash_key(), search.Found.Key, JSON.stringify( modified ) ] );
					} );
				if ( before !== after )
				{
					if ( before !== null ) { await delete_index( [ before ] ); }
					let pairs = [];
					append_index_writes( pairs, modified, search.Found.Key );
					await write_index( pairs );
				}
				modified_count++;
			}
			if ( Options.ReturnDocuments ) { return modified; }
			return modified_count;
		};


		//=====================================================================
		// DeleteOne
		//=====================================================================


		Storage.DeleteOne = async function ( Criteria, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			let search = await find_first( Criteria );
			let deleted = null;
			let deleted_count = 0;
			if ( search.Found )
			{
				deleted = search.Found.Document;
				await WithClient(
					async function ( Client )
					{
						return await Client.sendCommand( [ 'HDEL', hash_key(), search.Found.Key ] );
					} );
				let encoded = document_key_of( search.Found.Document );
				if ( encoded !== null ) { await delete_index( [ encoded ] ); }
				deleted_count++;
			}
			if ( Options.ReturnDocuments ) { return deleted; }
			return deleted_count;
		};


		//=====================================================================
		// DeleteMany
		//=====================================================================


		Storage.DeleteMany = async function ( Criteria, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			let entries = await read_documents();
			let matches_everything = criteria_matches_everything( Criteria );
			let command = [ 'HDEL', hash_key() ];
			let index_removals = [];
			let deleted = [];
			for ( let index = 0; index < entries.length; index++ )
			{
				let entry = entries[ index ];
				if ( !matches_everything && !jsongin.Query( entry.Document, Criteria ) ) { continue; }
				command.push( entry.Key );
				let encoded = document_key_of( entry.Document );
				if ( encoded !== null ) { index_removals.push( encoded ); }
				deleted.push( entry.Document );
			}
			if ( deleted.length )
			{
				await WithClient(
					async function ( Client )
					{
						return await Client.sendCommand( command );
					} );
				await delete_index( index_removals );
			}
			if ( Options.ReturnDocuments ) { return deleted; }
			return deleted.length;
		};


		//=====================================================================
		return Storage;
	},

};


//---------------------------------------------------------------------
// ***This package is one prime and eight aliases, and it spans two products.***
//
// The plan for this wave predicted two primes - one for Redis and one for Valkey - and
// ***the measurement retired that prediction on 2026-09-02.*** Over the surface this adapter
// uses, the two products are not merely compatible, they are identical:
//
//   - Every command this adapter sends - HSET, HGET, HDEL, HLEN, HSCAN, HGETALL, DEL, SELECT,
//     INFO, PING, MULTI, EXEC - is present on all five servers measured: Redis 6.2.24, 7.2.16
//     and 8.10.1, and Valkey 7.2.14 and 8.1.10.
//   - `HSCAN` answers with the same reply shape on all five: a cursor and a flat field/value
//     array, with `HLEN` agreeing.
//   - At the fork point the vocabularies are ***equal***: Redis 7.2.16 and Valkey 7.2.14 both
//     carry 241 commands, and neither has one the other lacks.
//   - One driver reaches both, which is what makes a single package possible at all.
//
// ***A prime is a named profile describing a real change in behavior***, so a second prime
// here would assert a difference which does not exist. Valkey is therefore an alias, and this
// is the primes-and-aliases model doing exactly what it was built for: the support claim grows
// with the alias table while the test obligation grows only with the primes.
//
// ***The two products have diverged, and none of it is here.*** Redis 8.10 carries 447 commands
// to Valkey 8.1's 242, and the 206 it has alone are the Redis Stack modules folded into core -
// search, probabilistic structures, vector sets. Valkey has exactly one command Redis lacks,
// `commandlog`. That whole gap sits in the query surface this wave deliberately does not
// enter, which is the same boundary `wave-2-key-value.md` named as what would earn a second
// prime. ***So the day jsonstor pushes a criteria down to Redis is the day Valkey earns its own
// profile***, and until then it does not.
//
// See jsonx/.plans/versioned-adapters.md and jsonx/.plans/wave-2-key-value.md.

const REDIS_V62 = {
	AdapterName: 'jsonstor-redis-v6.2',
	AdapterDescription: module.exports.AdapterDescription,
	GetAdapter: module.exports.GetAdapter,
	// ***The floor this profile starts at.*** 6.2 is the last widely deployed release before
	// the licence change, and it is a reach claim rather than a technical limit - the commands
	// used here are all far older. ***Declaring a floor higher than necessary costs reach;
	// declaring one lower than measured costs the truth of the number***, and 6.2 is the oldest
	// server this was actually run against.
	Version: [ 6, 2 ],
	// ***The newest server it has been run against, across both products.*** Redis 8.10.1 is
	// the highest version measured; Valkey's 8.1.10 sits below it, so one ceiling covers both.
	// Every part of it, because the comparison zero-pads and a short ceiling makes a prime warn
	// about its own test server.
	MeasuredTo: [ 8, 10, 1 ],
};

module.exports.Adapters = [ REDIS_V62 ];

// ***The bare names are listed here rather than left on the plugin object.*** Naming
// `jsonstor-redis` stops the plugin registering itself under it, so `GetStorage` reports the
// prime it resolved to instead of reporting itself as its own profile.
//
// ***`jsonstor-valkey` is a first class name and not a courtesy.*** A caller who runs Valkey
// should be able to say so, and `StorageInfo()` answers `Product: 'Valkey'` with that server's
// real version - it is only the ***profile*** which is shared, because only one was measured.
module.exports.Aliases = {
	'jsonstor-redis': 'jsonstor-redis-v6.2',
	'jsonstor-redis-v6': 'jsonstor-redis-v6.2',
	'jsonstor-redis-v7': 'jsonstor-redis-v6.2',
	'jsonstor-redis-v7.2': 'jsonstor-redis-v6.2',
	'jsonstor-redis-v8': 'jsonstor-redis-v6.2',
	'jsonstor-redis-v8.10': 'jsonstor-redis-v6.2',
	'jsonstor-valkey': 'jsonstor-redis-v6.2',
	'jsonstor-valkey-v7': 'jsonstor-redis-v6.2',
	'jsonstor-valkey-v7.2': 'jsonstor-redis-v6.2',
	'jsonstor-valkey-v8': 'jsonstor-redis-v6.2',
	'jsonstor-valkey-v8.1': 'jsonstor-redis-v6.2',
};
