const systemPath = require(`path`)
const normalize = require(`normalize-path`)
const _ = require(`lodash`)
const { GraphQLList, getNullableType, getNamedType, Kind } = require(`graphql`)
const { getValueAt } = require(`../utils/get-value-at`)

const findMany = typeName => ({ args, context, info }) =>
  context.nodeModel.runQuery(
    {
      query: args,
      firstOnly: false,
      type: info.schema.getType(typeName),
    },
    { path: context.path, connectionType: typeName }
  )

const findOne = typeName => ({ args, context, info }) =>
  context.nodeModel.runQuery(
    {
      query: { filter: args },
      firstOnly: true,
      type: info.schema.getType(typeName),
    },
    { path: context.path }
  )

const findManyPaginated = typeName => async rp => {
  // Peek into selection set and pass on the `field` arg of `group` and
  // `distinct` which might need to be resolved. The easiest way to check if
  // `group` or `distinct` are in the selection set is with the `projection`
  // field which is added by `graphql-compose`'s `Resolver`. If we find it
  // there, get the actual `field` arg.
  const group = rp.projection.group && getProjectedField(rp.info, `group`)
  const distinct =
    rp.projection.distinct && getProjectedField(rp.info, `distinct`)
  const args = { ...rp.args, group: group || [], distinct: distinct || [] }

  const result = await findMany(typeName)({ ...rp, args })
  return paginate(result, { skip: rp.args.skip, limit: rp.args.limit })
}

const distinct = (source, args, context, info) => {
  const { field } = args
  const { edges } = source
  const values = edges.reduce((acc, { node }) => {
    const value = getValueAt(node, field)
    return value != null
      ? acc.concat(value instanceof Date ? value.toISOString() : value)
      : acc
  }, [])
  return Array.from(new Set(values)).sort()
}

const group = (source, args, context, info) => {
  const { field } = args
  const { edges } = source
  const groupedResults = edges.reduce((acc, { node }) => {
    const value = getValueAt(node, field)
    const values = Array.isArray(value) ? value : [value]
    values
      .filter(value => value != null)
      .forEach(value => {
        const key = value instanceof Date ? value.toISOString() : value
        acc[key] = (acc[key] || []).concat(node)
      })
    return acc
  }, {})
  return Object.keys(groupedResults)
    .sort()
    .reduce((acc, fieldValue) => {
      acc.push({
        ...paginate(groupedResults[fieldValue], args),
        field,
        fieldValue,
      })
      return acc
    }, [])
}

const paginate = (results = [], { skip = 0, limit }) => {
  if (results === null) {
    results = []
  }

  const count = results.length
  const items = results.slice(skip, limit && skip + limit)

  const pageCount = limit
    ? Math.ceil(skip / limit) + Math.ceil((count - skip) / limit)
    : skip
    ? 2
    : 1
  const currentPage = limit ? Math.ceil(skip / limit) + 1 : skip ? 2 : 1
  const hasPreviousPage = currentPage > 1
  const hasNextPage = skip + limit < count

  return {
    totalCount: count,
    edges: items.map((item, i, arr) => {
      return {
        node: item,
        next: arr[i + 1],
        previous: arr[i - 1],
      }
    }),
    nodes: items,
    pageInfo: {
      currentPage,
      hasPreviousPage,
      hasNextPage,
      itemCount: items.length,
      pageCount,
      perPage: limit,
    },
  }
}

const link = ({ by = `id`, from }, originalResolver) => async (
  source,
  args,
  context,
  info
) => {
  const fieldValue = await originalResolver(source, args, context, {
    ...info,
    fieldName: from || info.fieldName,
  })

  if (fieldValue == null || _.isPlainObject(fieldValue)) return fieldValue
  if (
    Array.isArray(fieldValue) &&
    (fieldValue[0] == null || _.isPlainObject(fieldValue[0]))
  ) {
    return fieldValue
  }

  const returnType = getNullableType(info.returnType)
  const type = getNamedType(returnType)

  if (by === `id`) {
    if (Array.isArray(fieldValue)) {
      return context.nodeModel.getNodesByIds(
        { ids: fieldValue, type: type },
        { path: context.path }
      )
    } else {
      return context.nodeModel.getNodeById(
        { id: fieldValue, type: type },
        { path: context.path }
      )
    }
  }

  const equals = value => {
    return { eq: value }
  }
  const oneOf = value => {
    return { in: value }
  }
  const operator = Array.isArray(fieldValue) ? oneOf : equals
  args.filter = by.split(`.`).reduceRight((acc, key, i, { length }) => {
    return {
      [key]: i === length - 1 ? operator(acc) : acc,
    }
  }, fieldValue)

  const result = await context.nodeModel.runQuery(
    { query: args, firstOnly: !(returnType instanceof GraphQLList), type },
    { path: context.path }
  )
  if (
    returnType instanceof GraphQLList &&
    Array.isArray(fieldValue) &&
    Array.isArray(result)
  ) {
    return fieldValue.map(value =>
      result.find(obj => getValueAt(obj, by) === value)
    )
  } else {
    return result
  }
}

const fileByPath = ({ from }, originalResolver) => async (
  source,
  args,
  context,
  info
) => {
  const fieldValue = await originalResolver(source, args, context, {
    ...info,
    fieldName: from || info.fieldName,
  })

  if (fieldValue == null || _.isPlainObject(fieldValue)) return fieldValue
  if (
    Array.isArray(fieldValue) &&
    (fieldValue[0] == null || _.isPlainObject(fieldValue[0]))
  ) {
    return fieldValue
  }

  const findLinkedFileNode = relativePath => {
    // Use the parent File node to create the absolute path to
    // the linked file.
    const fileLinkPath = normalize(
      systemPath.resolve(parentFileNode.dir, relativePath)
    )

    // Use that path to find the linked File node.
    const linkedFileNode = _.find(
      context.nodeModel.getAllNodes({ type: `File` }),
      n => n.absolutePath === fileLinkPath
    )
    return linkedFileNode
  }

  // Find the File node for this node (we assume the node is something
  // like markdown which would be a child node of a File node).
  const parentFileNode = context.nodeModel.findRootNodeAncestor(
    source,
    node => node.internal && node.internal.type === `File`
  )

  return resolveValue(findLinkedFileNode, fieldValue)
}

const resolveValue = (resolve, value) =>
  Array.isArray(value)
    ? value.map(v => resolveValue(resolve, v))
    : resolve(value)

const getProjectedField = (info, fieldName) => {
  const selectionSet = info.fieldNodes[0].selectionSet
  const fieldNodes = getFieldNodeByNameInSelectionSet(
    selectionSet,
    fieldName,
    info
  )

  const fieldEnum = getNullableType(
    getNullableType(info.returnType)
      .getFields()
      [fieldName].args.find(arg => arg.name === `field`).type
  )

  return fieldNodes.reduce((acc, fieldNode) => {
    const fieldArg = fieldNode.arguments.find(arg => arg.name.value === `field`)
    if (fieldArg) {
      const enumKey = fieldArg.value.value
      return [...acc, fieldEnum.getValue(enumKey).value]
    } else {
      return acc
    }
  }, [])
}

const getFieldNodeByNameInSelectionSet = (selectionSet, fieldName, info) =>
  selectionSet.selections.reduce((acc, selection) => {
    if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const fragmentDef = info.fragments[selection.name.value]
      if (fragmentDef) {
        return [
          ...acc,
          ...getFieldNodeByNameInSelectionSet(
            fragmentDef.selectionSet,
            fieldName,
            info
          ),
        ]
      }
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      return [
        ...acc,
        ...getFieldNodeByNameInSelectionSet(
          selection.selectionSet,
          fieldName,
          info
        ),
      ]
    } /* FIELD_NODE */ else {
      if (selection.name.value === fieldName) {
        return [...acc, selection]
      }
    }
    return acc
  }, [])

module.exports = {
  findManyPaginated,
  findOne,
  fileByPath,
  link,
  distinct,
  group,
  paginate,
}
